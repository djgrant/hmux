/**
 * The tmux backend: the user's own default tmux server, untouched config.
 * mux never interprets what runs inside a pane — panes advertise their own
 * state via tmux user options (@humans_status / @humans_detail, README) and
 * this module reads them back and rolls them up pane → window → session.
 */
import { topStatus, type Backend, type DisplayTarget, type SessionGroup, type WindowEntry } from "./backend"
import { focusTerminal } from "@humans/focus"
import { HOLD_SESSION, registeredTargets } from "./targets"

const SEP = "\x1f" // unit separator: can't appear in names/paths

async function tmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`tmux ${args[0]} exited ${code}`)
  return out
}

/** Strip control chars so advertised text can't corrupt the UI. */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

function tilde(dir: string): string {
  return dir.replace(new RegExp(`^${process.env.HOME}`), "~")
}

interface PaneRow {
  session: string
  windowIndex: string
  windowName: string
  windowActive: boolean
  paneActive: boolean
  currentPath: string
  agent: string | null
  status: string | null
  detail: string | null
}

/**
 * $TMUX in the env is hearsay: a terminal app launched from inside tmux
 * inherits it (LaunchServices propagates the launcher's environment), and
 * every shell it spawns then looks "inside tmux" while having no client.
 * Genuinely inside means the advertised pane's root process is an ancestor
 * of ours — that holds through pty-nesting wrappers and rejects inherited env.
 */
export async function insideTmux(): Promise<boolean> {
  const pane = process.env.TMUX_PANE
  if (!process.env.TMUX || !pane) return false
  try {
    const out = await tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"])
    const panePid = Number(out.trim())
    if (!panePid) return false
    let pid = process.pid
    for (let hops = 0; pid > 1 && hops < 50; hops++) {
      if (pid === panePid) return true
      pid = Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim())
      if (!Number.isFinite(pid)) break
    }
  } catch {}
  return false
}

/**
 * Scratch session that hosts the resurrect restore; killed (or left as the
 * server's death warrant) before ensure() returns, filtered from list()
 * defensively in case a crash strands one.
 */
const BOOT_SESSION = "__mux_boot"

/** tpm's default and XDG plugin homes; null when resurrect isn't installed. */
function resurrectRestoreScript(): string | null {
  const home = process.env.HOME ?? ""
  for (const base of [`${home}/.tmux/plugins`, `${home}/.config/tmux/plugins`]) {
    const script = `${base}/tmux-resurrect/scripts/restore.sh`
    if (Bun.file(script).size > 0) return script
  }
  return null
}

export class TmuxBackend implements Backend {
  /** Pass the result of insideTmux(); the env var alone is not trusted. */
  constructor(private inTmux = false) {}

  async ensure(): Promise<void> {
    const alive = await tmux(["list-sessions"]).then(() => true, () => false)
    if (alive) return
    const restore = resurrectRestoreScript()
    if (!restore) return // nothing to restore from; create() births the server later

    console.error("mux: no tmux server — restoring last snapshot…")
    // Resurrect needs a live server to add sessions into, and derives its
    // socket from $TMUX (empty here — we're a client-less process), so birth
    // a scratch session and point $TMUX at the real socket ourselves.
    await tmux(["new-session", "-d", "-s", BOOT_SESSION])
    const socket = (await tmux(["display-message", "-p", "#{socket_path}"]).catch(() => "")).trim()
    if (socket) {
      const proc = Bun.spawn([restore], {
        env: { ...process.env, TMUX: `${socket},,` },
        stdout: "ignore",
        stderr: "ignore",
      })
      await proc.exited
    }
    // Drop the scratch session. If the snapshot was empty this kills the
    // server too — the picker opens empty rather than inventing a session.
    await tmux(["kill-session", "-t", BOOT_SESSION]).catch(() => {})
  }

  async list(): Promise<SessionGroup[]> {
    let sessionsOut: string
    try {
      sessionsOut = await tmux([
        "list-sessions",
        "-F",
        `#{session_name}${SEP}#{session_path}${SEP}#{session_attached}`,
      ])
    } catch {
      return [] // no server running
    }

    const panesBySession = new Map<string, PaneRow[]>()
    try {
      const panesOut = await tmux([
        "list-panes",
        "-a",
        "-F",
        `#{session_name}${SEP}#{window_index}${SEP}#{window_name}${SEP}#{window_active}${SEP}#{pane_active}${SEP}#{pane_current_path}${SEP}#{@humans_agent}${SEP}#{@humans_status}${SEP}#{@humans_detail}`,
      ])
      for (const line of panesOut.split("\n")) {
        if (!line) continue
        const [session, windowIndex, windowName, windowActive, paneActive, currentPath, agent, status, detail] =
          line.split(SEP)
        const rows = panesBySession.get(session) ?? []
        rows.push({
          session,
          windowIndex,
          windowName: sanitize(windowName),
          windowActive: windowActive === "1",
          paneActive: paneActive === "1",
          currentPath,
          agent: agent ? sanitize(agent) : null,
          status: status ? sanitize(status) : null,
          detail: detail ? sanitize(detail) : null,
        })
        panesBySession.set(session, rows)
      }
    } catch {}

    const groups: SessionGroup[] = []
    for (const line of sessionsOut.split("\n")) {
      if (!line) continue
      const [name, dir, attached] = line.split(SEP)
      if (name === HOLD_SESSION || name === BOOT_SESSION) continue // mux's own plumbing, not a session
      const panes = panesBySession.get(name) ?? []

      // Group panes into windows, preserving tmux's window order.
      const byIndex = new Map<string, PaneRow[]>()
      for (const p of panes) {
        const list = byIndex.get(p.windowIndex) ?? []
        list.push(p)
        byIndex.set(p.windowIndex, list)
      }
      const windows: WindowEntry[] = []
      for (const [index, wPanes] of byIndex) {
        const active = wPanes.find((p) => p.paneActive) ?? wPanes[0]
        // Agent identity from whichever pane advertised one — a cc session
        // is usually not the active pane while you look at the dashboard.
        const agent = wPanes.find((p) => p.agent)?.agent ?? null
        windows.push({
          target: `${name}:${index}`,
          session: name,
          name: active.windowName,
          dir: tilde(active.currentPath),
          agent,
          active: active.windowActive,
          paneCount: wPanes.length,
          ...topStatus(wPanes),
        })
      }

      // session_path is empty on some sessions (e.g. created without -c);
      // fall back to where the first window's active pane actually is.
      groups.push({
        target: name,
        name,
        dir: (dir ? tilde(dir) : "") || windows[0]?.dir || "",
        attached: attached !== "0",
        windows,
        ...topStatus(windows),
      })
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name))
  }

  opensInPlace(): boolean {
    return this.inTmux
  }

  async open(target: string): Promise<void> {
    // target is "session" or "session:windowIndex". Select the window first
    // so both attach and switch-client land on it.
    if (target.includes(":")) await tmux(["select-window", "-t", target]).catch(() => {})
    const session = target.split(":")[0]
    if (this.inTmux) {
      // Router lives in its own pane; this client just retargets.
      await tmux(["switch-client", "-t", session])
      return
    }
    // Hand the terminal to a plain attach — the parent terminal renders the
    // session natively. Resolves when the user detaches (prefix d).
    const proc = Bun.spawn(["tmux", "attach", "-t", session], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
  }

  async targets(): Promise<DisplayTarget[]> {
    const registered = registeredTargets()
    if (registered.length === 0) return []
    try {
      const out = await tmux(["list-clients", "-F", `#{client_tty}${SEP}#{client_control_mode}`])
      const live = new Map(
        out
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [tty, control] = line.split(SEP)
            return [tty, control === "1"] as const
          }),
      )
      return registered
        .filter((t) => live.has(t.tty))
        .map((t) => ({ ...t, controlMode: live.get(t.tty) }))
    } catch {
      return []
    }
  }

  async peekInClient(target: string, client: DisplayTarget): Promise<void> {
    if (target.includes(":")) await tmux(["select-window", "-t", target]).catch(() => {})
    await tmux(["switch-client", "-c", client.tty, "-t", target.split(":")[0]])
  }

  async openInClient(target: string, client: DisplayTarget): Promise<void> {
    await this.peekInClient(target, client)
    // focusTerminal stamps titles through the tty — fatal to a control-mode
    // client, whose tty is the iTerm %-protocol channel. Jiggle-repaint the
    // alt-screen panes, give the redraw 300ms to land, then activate.
    if (client.controlMode) {
      await this.repaintSession(target.split(":")[0]).catch(() => {})
      if (process.platform === "darwin" && client.program === "iTerm.app")
        Bun.spawn(["osascript", "-e", 'tell application "iTerm2" to activate'], {
          stdout: "ignore",
          stderr: "ignore",
        })
      return
    }
    focusTerminal(client).catch(() => {}) // fire-and-forget: focus never blocks or fails the open
  }

  /**
   * iTerm builds -CC windows from tmux's stored grid, which misses
   * alternate-screen apps — TUIs come up blank until a real size change
   * makes them repaint (SIGWINCH alone is ignored at unchanged size).
   * Jiggle one column and back, but only windows that hold an alt-screen
   * pane: TUIs redraw without scrolling, and plain shell windows — where a
   * resize means visible scroll jumps — are left alone. Afterwards drop the
   * manual-size override so the client owns sizing again.
   */
  private async repaintSession(session: string): Promise<void> {
    const out = await tmux([
      "list-panes", "-s", "-t", session, "-F",
      `#{window_id}${SEP}#{window_width}${SEP}#{window_height}${SEP}#{alternate_on}`,
    ])
    const wins = new Map<string, { w: string; h: string; alt: boolean }>()
    for (const line of out.split("\n")) {
      if (!line) continue
      const [id, w, h, alt] = line.split(SEP)
      const prev = wins.get(id)
      wins.set(id, { w, h, alt: (prev?.alt ?? false) || alt === "1" })
    }
    for (const [id, { w, h, alt }] of wins) {
      if (!alt) continue
      await tmux(["resize-window", "-t", id, "-x", String(Number(w) - 1), "-y", h])
      await tmux(["resize-window", "-t", id, "-x", w, "-y", h])
      await tmux(["set-option", "-w", "-t", id, "-u", "window-size"])
    }
  }

  async create(name: string): Promise<void> {
    await tmux(["new-session", "-d", "-s", name, "-c", process.env.HOME ?? "/"])
  }

  async rename(target: string, to: string): Promise<void> {
    const verb = target.includes(":") ? "rename-window" : "rename-session"
    await tmux([verb, "-t", target, to])
  }

  async kill(target: string): Promise<void> {
    const verb = target.includes(":") ? "kill-window" : "kill-session"
    await tmux([verb, "-t", target])
  }
}
