/**
 * Thin tmux shell layer. The app never interprets what runs inside a pane —
 * panes advertise their own state via tmux user options (see README:
 * @humans_status / @humans_detail) and this module just reads them back.
 */

export type Status = "waiting" | "busy" | "error" | "idle" | (string & {})

export interface Pane {
  session: string
  paneId: string
  /** true when this is the active pane of the session's active window. */
  active: boolean
  currentPath: string
  status: Status | null
  detail: string | null
}

export interface Session {
  name: string
  dir: string
  attached: boolean
  windows: number
  /** Highest-priority advertised status across the session's panes. */
  status: Status | null
  detail: string | null
}

/** waiting beats error beats busy beats idle beats unadvertised. */
const PRIORITY: Record<string, number> = { waiting: 4, error: 3, busy: 2, idle: 1 }

const SEP = "\x1f" // unit separator: can't appear in names/paths

async function tmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`tmux ${args[0]} exited ${code}`)
  return out
}

/** Strip control chars so advertised text / captured output can't corrupt the UI. */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

export async function listSessions(): Promise<Session[]> {
  let sessionsOut: string
  try {
    sessionsOut = await tmux([
      "list-sessions",
      "-F",
      `#{session_name}${SEP}#{session_path}${SEP}#{session_attached}${SEP}#{session_windows}`,
    ])
  } catch {
    return [] // no server running
  }

  // Advertised state lives on panes (a pane knows itself; a session doesn't),
  // rolled up here to a per-session badge.
  const bySession = new Map<string, Pane[]>()
  try {
    const panesOut = await tmux([
      "list-panes",
      "-a",
      "-F",
      `#{session_name}${SEP}#{pane_id}${SEP}#{window_active}#{pane_active}${SEP}#{pane_current_path}${SEP}#{@humans_status}${SEP}#{@humans_detail}`,
    ])
    for (const line of panesOut.split("\n")) {
      if (!line) continue
      const [session, paneId, activeFlags, currentPath, status, detail] = line.split(SEP)
      const list = bySession.get(session) ?? []
      list.push({
        session,
        paneId,
        active: activeFlags === "11",
        currentPath,
        status: status ? sanitize(status) : null,
        detail: detail ? sanitize(detail) : null,
      })
      bySession.set(session, list)
    }
  } catch {}

  const sessions: Session[] = []
  for (const line of sessionsOut.split("\n")) {
    if (!line) continue
    const [name, dir, attached, windows] = line.split(SEP)
    const panes = bySession.get(name) ?? []
    const top = panes
      .filter((p) => p.status)
      .sort((a, b) => (PRIORITY[b.status!] ?? 0) - (PRIORITY[a.status!] ?? 0))[0]
    // session_path is empty on some sessions (e.g. created without -c);
    // fall back to where the active pane actually is.
    const effectiveDir = dir || panes.find((p) => p.active)?.currentPath || ""
    sessions.push({
      name,
      dir: effectiveDir.replace(new RegExp(`^${process.env.HOME}`), "~"),
      attached: attached !== "0",
      windows: Number(windows) || 0,
      status: top?.status ?? null,
      detail: top?.detail ?? null,
    })
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name))
}

/** Last screenful of the session's active pane, control chars stripped. */
export async function peek(session: string): Promise<string[]> {
  try {
    const out = await tmux(["capture-pane", "-p", "-t", session])
    const lines = out.split("\n").map(sanitize)
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
    return lines
  } catch {
    return []
  }
}

export const insideTmux = () => !!process.env.TMUX

/** Open from within tmux: retarget this client, the router pane stays put. */
export async function switchClient(session: string): Promise<void> {
  await tmux(["switch-client", "-t", session])
}

/**
 * Open from outside tmux: hand the terminal to `tmux attach` until the user
 * detaches. Caller must suspend/resume the renderer around this.
 */
export function attachBlocking(session: string): void {
  Bun.spawnSync(["tmux", "attach", "-t", session], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
}

export async function newSession(name: string): Promise<void> {
  await tmux(["new-session", "-d", "-s", name, "-c", process.env.HOME ?? "/"])
}

export async function renameSession(from: string, to: string): Promise<void> {
  await tmux(["rename-session", "-t", from, to])
}

export async function killSession(name: string): Promise<void> {
  await tmux(["kill-session", "-t", name])
}
