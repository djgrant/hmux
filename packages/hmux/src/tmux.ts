/**
 * The tmux backend: the user's own default tmux server, untouched config.
 * hmux never interprets what runs inside a pane — panes advertise their own
 * state via tmux user options (@hmux_status / @hmux_detail, written by
 * `hmux advertise`) and this module reads them back and rolls them up
 * pane → window → session.
 */
import { statSync } from "node:fs"
import { topStatus, type Backend, type DisplayTarget, type SessionGroup, type WindowEntry } from "./backend"
import { focusTerminal } from "terminal-focus"
import { HOLD_SESSION, registeredTargets } from "./targets"

const SEP = "\x1f" // unit separator: can't appear in names/paths

export async function tmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`tmux ${args[0]} exited ${code}`)
  return out
}

/** True when the pid exists (EPERM still means alive, just not ours). */
function advertiserAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Strip control chars so advertised text can't corrupt the UI. */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

function tilde(dir: string): string {
  return dir.replace(new RegExp(`^${process.env.HOME}`), "~")
}

/** Inverse of tilde: expand a leading ~ back to HOME. list() hands out tilde'd
 * dirs, so a dir routed straight back into create() needs undoing. */
function untilde(dir: string | undefined): string | undefined {
  if (!dir) return dir
  return dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
}

/** The current working directory of a session's active pane, absolute and
 * untilde'd — what a new window should inherit. null when tmux can't resolve
 * it (e.g. the session vanished between calls). */
async function sessionDir(session: string): Promise<string | null> {
  // The trailing colon matters: `=session` (session only) resolves no pane and
  // #{pane_current_path} comes back empty, whereas `=session:` targets the
  // session's active window — still an exact match on the name — and resolves.
  const dir = await tmux(["display-message", "-p", "-t", `=${session}:`, "#{pane_current_path}"]).catch(() => "")
  return dir.trim() || null
}

interface PaneRow {
  session: string
  windowIndex: string
  windowName: string
  windowActive: boolean
  paneActive: boolean
  paneId: string
  paneIndex: number
  currentPath: string
  agent: string | null
  status: string | null
  detail: string | null
  transcript: string | null
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

/** Global user option the picker parks its last cursor in. */
const SELECTION_OPT = "@hmux-selection"

/** tpm's default and XDG plugin homes; null when resurrect isn't installed. */
function resurrectScript(name: "save.sh" | "restore.sh"): string | null {
  const home = process.env.HOME ?? ""
  for (const base of [`${home}/.tmux/plugins`, `${home}/.config/tmux/plugins`]) {
    const script = `${base}/tmux-resurrect/scripts/${name}`
    if (Bun.file(script).size > 0) return script
  }
  return null
}

/**
 * Panes advertise a resume command (@hmux_resume via `hmux advertise`) that
 * brings their occupant back after a restore. Pane options die with the
 * server, so save() copies them into this manifest and ensure() replays
 * them once resurrect has rebuilt the panes.
 */
const RESUME_MANIFEST = `${process.env.HOME}/.local/share/hmux/resume.json`

/** How often the snapshot is refreshed, machine-wide (see save()). */
const SAVE_INTERVAL_MS = 60_000

/** Shells it is safe to type a resume command into. */
const SHELLS = new Set(["zsh", "bash", "fish", "sh"])

/**
 * Resurrect's scripts derive their socket from $TMUX, which is empty in a
 * client-less process like hmux — point it at the real socket explicitly.
 */
async function runResurrect(script: string, args: string[] = []): Promise<void> {
  const socket = (await tmux(["display-message", "-p", "#{socket_path}"]).catch(() => "")).trim()
  if (!socket) return
  const proc = Bun.spawn([script, ...args], {
    env: { ...process.env, TMUX: `${socket},,` },
    stdout: "ignore",
    stderr: "ignore",
  })
  await proc.exited
}

export class TmuxBackend implements Backend {
  /** Pass the result of insideTmux(); the env var alone is not trusted. */
  constructor(private inTmux = false) {}

  /** Unset a dead advertiser's attention options (see list()). Failure-silent. */
  private async clearGhost(paneId: string): Promise<void> {
    for (const option of ["@hmux_status", "@hmux_detail", "@hmux_agent", "@hmux_pid"]) {
      await tmux(["set-option", "-pu", "-t", paneId, option]).catch(() => {})
    }
  }

  async ensure(): Promise<void> {
    // Persistence rides along with readiness: every long-lived hmux process
    // (picker or parked target) refreshes the snapshot; the mtime guard in
    // save() collapses them to one save per interval machine-wide.
    if (resurrectScript("save.sh"))
      setInterval(() => void this.save().catch(() => {}), SAVE_INTERVAL_MS)
    const alive = await tmux(["list-sessions"]).then(() => true, () => false)
    if (alive) return
    const restore = resurrectScript("restore.sh")
    if (!restore) return // nothing to restore from; create() births the server later

    console.error("hmux: no tmux server — restoring last snapshot…")
    // Resurrect needs a live server to add sessions into: birth a scratch
    // session for it to work against.
    await tmux(["new-session", "-d", "-s", BOOT_SESSION])
    await runResurrect(restore)
    // Drop the scratch session. If the snapshot was empty this kills the
    // server too — the picker opens empty rather than inventing a session.
    await tmux(["kill-session", "-t", BOOT_SESSION]).catch(() => {})
    await this.replayResumes().catch(() => {})
  }

  private async save(): Promise<void> {
    const script = resurrectScript("save.sh")
    if (!script) return
    // Every hmux process runs its own save timer, so the last write acts as
    // the shared clock: skip when a recent save exists and N processes
    // collapse to roughly one save per interval machine-wide.
    try {
      const age = Date.now() - statSync(RESUME_MANIFEST).mtimeMs
      if (age < SAVE_INTERVAL_MS - 5_000) return
    } catch {} // no manifest yet — save
    // Only real sessions are worth snapshotting: saving while just hmux's own
    // plumbing exists would overwrite the last good snapshot with an empty one.
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]).catch(() => "")
    const real = out.split("\n").filter((s) => s && s !== HOLD_SESSION && s !== BOOT_SESSION)
    if (real.length === 0) return
    await runResurrect(script, ["quiet"])
    await this.saveResumes().catch(() => {})
  }

  /** Copy advertised resume commands off the panes into the manifest. */
  private async saveResumes(): Promise<void> {
    const out = await tmux([
      "list-panes", "-a", "-F",
      `#{session_name}:#{window_index}.#{pane_index}${SEP}#{@hmux_resume}`,
    ])
    const resumes: Record<string, string> = {}
    for (const line of out.split("\n")) {
      if (!line) continue
      const [target, command] = line.split(SEP)
      const session = target.split(":")[0]
      if (session === HOLD_SESSION || session === BOOT_SESSION) continue
      if (command) resumes[target] = command
    }
    await Bun.write(RESUME_MANIFEST, JSON.stringify(resumes, null, 2))
  }

  /**
   * Type each manifest command into its restored pane. Resurrect brings
   * panes back as bare shells at their old cwd under the same
   * session:window.pane targets, so matching is by target — a session
   * renamed between save and restore loses its resume. Panes running
   * anything other than a bare shell are skipped, so a re-run cannot type
   * into a session that already resumed.
   */
  private async replayResumes(): Promise<void> {
    const manifest = await Bun.file(RESUME_MANIFEST)
      .json()
      .catch(() => null)
    if (!manifest || typeof manifest !== "object") return
    const out = await tmux([
      "list-panes", "-a", "-F",
      `#{session_name}:#{window_index}.#{pane_index}${SEP}#{pane_current_command}`,
    ]).catch(() => "")
    const shellPanes = new Set(
      out
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(SEP) as [string, string])
        .filter(([, command]) => SHELLS.has(command))
        .map(([target]) => target),
    )
    for (const [target, command] of Object.entries(manifest as Record<string, string>)) {
      if (typeof command !== "string" || !shellPanes.has(target)) continue
      await tmux(["send-keys", "-t", target, command, "Enter"]).catch(() => {})
    }
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
        `#{session_name}${SEP}#{window_index}${SEP}#{window_name}${SEP}#{window_active}${SEP}#{pane_active}${SEP}#{pane_id}${SEP}#{pane_index}${SEP}#{pane_current_path}${SEP}#{@hmux_agent}${SEP}#{@hmux_status}${SEP}#{@hmux_detail}${SEP}#{@hmux_transcript}${SEP}#{@hmux_pid}`,
      ])
      for (const line of panesOut.split("\n")) {
        if (!line) continue
        const [session, windowIndex, windowName, windowActive, paneActive, paneId, paneIndex, currentPath, agent, status, detail, transcript, pid] =
          line.split(SEP)
        // Advertised state is only as alive as its advertiser (@hmux_pid,
        // stamped by `hmux advertise`). A dead advertiser means the agent was
        // killed or crashed before its clear could run: present the pane as
        // unadvertised and heal the ghost options so every reader agrees.
        // Every writer goes through `hmux advertise`, which always stamps a
        // pid, so pid-less state is a ghost from before the pid existed.
        // resume/transcript survive — they exist to outlast the occupant.
        const stale = !!(agent || status) && !advertiserAlive(Number(pid))
        if (stale) void this.clearGhost(paneId)
        const rows = panesBySession.get(session) ?? []
        rows.push({
          session,
          windowIndex,
          windowName: sanitize(windowName),
          windowActive: windowActive === "1",
          paneActive: paneActive === "1",
          paneId,
          paneIndex: Number(paneIndex),
          currentPath,
          agent: agent && !stale ? sanitize(agent) : null,
          status: status && !stale ? sanitize(status) : null,
          detail: detail && !stale ? sanitize(detail) : null,
          transcript: transcript ? sanitize(transcript) : null,
        })
        panesBySession.set(session, rows)
      }
    } catch {}

    const groups: SessionGroup[] = []
    for (const line of sessionsOut.split("\n")) {
      if (!line) continue
      const [name, dir, attached] = line.split(SEP)
      if (name === HOLD_SESSION || name === BOOT_SESSION) continue // hmux's own plumbing, not a session
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
        // paneId and transcript follow the same pane: send/read address the
        // agent's pane, not wherever the cursor happens to be.
        const agentPane = wPanes.find((p) => p.agent || p.transcript)
        windows.push({
          target: `${name}:${index}`,
          session: name,
          name: active.windowName,
          dir: tilde(active.currentPath),
          agent: agentPane?.agent ?? null,
          active: active.windowActive,
          paneCount: wPanes.length,
          paneId: (agentPane ?? active).paneId,
          transcript: agentPane?.transcript ?? null,
          ...topStatus(wPanes),
          panes: wPanes.map((p) => ({
            paneId: p.paneId,
            paneIndex: p.paneIndex,
            dir: tilde(p.currentPath),
            agent: p.agent,
            active: p.paneActive,
            transcript: p.transcript,
            status: p.status,
            detail: p.detail,
          })),
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

  async create(name: string, opts?: { dir?: string; command?: string }): Promise<string> {
    const explicitDir = untilde(opts?.dir)
    // A birthed session has no parent to inherit from, so it falls back to HOME
    // when no dir was given. A window added to an existing session does have a
    // parent: it inherits that session's active pane cwd (least surprise — the
    // same as opening a window by hand), and only HOME as a last resort.
    const birthDir = explicitDir ?? process.env.HOME ?? "/"
    const slash = name.indexOf("/")
    // No slash: a plain session, its header its own target.
    if (slash < 0) {
      await tmux(["new-session", "-d", "-s", name, "-c", birthDir])
      await this.launch(name, opts?.command)
      return name
    }
    // "session/window": a window under the named session. If the session is
    // new it's born holding this window, and — being single-windowed — it
    // collapses to a session header, so the header is the target.
    const session = name.slice(0, slash)
    const window = name.slice(slash + 1)
    const exists = await tmux(["has-session", "-t", `=${session}`]).then(() => true, () => false)
    if (!exists) {
      await tmux(["new-session", "-d", "-s", session, "-n", window, "-c", birthDir])
      await this.launch(session, opts?.command)
      return session
    }
    // Existing session: add the window in the session's current directory
    // unless the caller pinned one — resolve the session's active pane cwd so
    // the window lands beside its siblings, not in HOME.
    const windowDir = explicitDir ?? (await sessionDir(session)) ?? process.env.HOME ?? "/"
    const index = (
      await tmux(["new-window", "-t", `=${session}:`, "-n", window, "-c", windowDir, "-P", "-F", "#{window_index}"])
    ).trim()
    const target = `${session}:${index}`
    await this.launch(target, opts?.command)
    return target
  }

  /**
   * Run a command in a freshly-created window's active pane. send-keys types
   * it as if at the shell prompt (a plain command line, not a TUI paste), so
   * the shell survives when the command exits — the pane stays a session, not
   * a one-shot that vanishes. A no-op when no command was requested.
   */
  private async launch(target: string, command?: string): Promise<void> {
    if (!command) return
    await tmux(["send-keys", "-t", target, command, "Enter"])
  }

  async send(target: string, message: string): Promise<void> {
    // Buffer paste instead of send-keys: send-keys mangles multiline text
    // and bypasses bracketed paste, which TUIs rely on to keep a pasted
    // message as one prompt entry. The delay before Enter lets the paste
    // settle before submission.
    const proc = Bun.spawn(["tmux", "load-buffer", "-b", "hmux-send", "-"], {
      stdin: new TextEncoder().encode(message),
      stdout: "ignore",
      stderr: "pipe",
    })
    if ((await proc.exited) !== 0) throw new Error("tmux load-buffer failed")
    await tmux(["paste-buffer", "-d", "-b", "hmux-send", "-t", target])
    await new Promise((r) => setTimeout(r, 150))
    await tmux(["send-keys", "-t", target, "Enter"])
  }

  async rename(target: string, to: string): Promise<void> {
    const verb = target.includes(":") ? "rename-window" : "rename-session"
    await tmux([verb, "-t", target, to])
  }

  async kill(target: string): Promise<void> {
    const verb = target.includes(":") ? "kill-window" : "kill-session"
    await tmux([verb, "-t", target])
  }

  // The cursor rides a global user option: set with the server, gone with it.
  async saveSelection(target: string): Promise<void> {
    await tmux(["set-option", "-gq", SELECTION_OPT, target]).catch(() => {})
  }

  async loadSelection(): Promise<string | null> {
    const value = await tmux(["show-options", "-gqv", SELECTION_OPT]).catch(() => "")
    return value.trim() || null
  }
}
