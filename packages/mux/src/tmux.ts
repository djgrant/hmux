/**
 * The tmux backend: the user's own default tmux server, untouched config.
 * mux never interprets what runs inside a pane — panes advertise their own
 * state via tmux user options (@humans_status / @humans_detail, README) and
 * this module reads them back and rolls them up pane → window → session.
 */
import { topStatus, type Backend, type SessionGroup, type WindowEntry } from "./backend"
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
  paneActive: boolean
  currentPath: string
  agent: string | null
  status: string | null
  detail: string | null
}

export class TmuxBackend implements Backend {
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
        `#{session_name}${SEP}#{window_index}${SEP}#{window_name}${SEP}#{pane_active}${SEP}#{pane_current_path}${SEP}#{@humans_agent}${SEP}#{@humans_status}${SEP}#{@humans_detail}`,
      ])
      for (const line of panesOut.split("\n")) {
        if (!line) continue
        const [session, windowIndex, windowName, paneActive, currentPath, agent, status, detail] =
          line.split(SEP)
        const rows = panesBySession.get(session) ?? []
        rows.push({
          session,
          windowIndex,
          windowName: sanitize(windowName),
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
      if (name === HOLD_SESSION) continue // mux's own plumbing, not a session
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
    return !!process.env.TMUX
  }

  async open(target: string): Promise<void> {
    // target is "session" or "session:windowIndex". Select the window first
    // so both attach and switch-client land on it.
    if (target.includes(":")) await tmux(["select-window", "-t", target]).catch(() => {})
    const session = target.split(":")[0]
    if (this.opensInPlace()) {
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

  async targets(): Promise<string[]> {
    const registered = registeredTargets()
    if (registered.length === 0) return []
    try {
      const out = await tmux(["list-clients", "-F", "#{client_tty}"])
      const live = new Set(out.split("\n").filter(Boolean))
      return registered.filter((tty) => live.has(tty))
    } catch {
      return []
    }
  }

  async openInClient(target: string, client: string): Promise<void> {
    if (target.includes(":")) await tmux(["select-window", "-t", target]).catch(() => {})
    await tmux(["switch-client", "-c", client, "-t", target.split(":")[0]])
  }

  async create(name: string): Promise<void> {
    await tmux(["new-session", "-d", "-s", name, "-c", process.env.HOME ?? "/"])
  }

  async rename(session: string, to: string): Promise<void> {
    await tmux(["rename-session", "-t", session, to])
  }

  async kill(session: string): Promise<void> {
    await tmux(["kill-session", "-t", session])
  }
}
