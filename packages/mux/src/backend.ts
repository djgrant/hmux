/**
 * The backend seam. mux itself is the advertise protocol + dashboard; a
 * backend supplies the three separable roles tmux plays today:
 *   discovery (what sessions/windows exist), signals (advertised state),
 *   and open (how to get there). Other transports can implement this later;
 *   tmux is the bundled default (see tmux.ts).
 */

export type Status = "waiting" | "busy" | "error" | "idle" | (string & {})

export interface WindowEntry {
  /** Backend-opaque handle passed back to open(). */
  target: string
  session: string
  name: string
  dir: string
  /** Advertised agent identity (e.g. "api-3f2c · sonnet") when a cc session runs here. */
  agent: string | null
  /** What's running in the window's active pane (e.g. "claude", "vim"). */
  command: string | null
  paneCount: number
  /** Advertised state rolled up from the window's panes. */
  status: Status | null
  detail: string | null
}

export interface SessionGroup {
  target: string
  name: string
  dir: string
  attached: boolean
  windows: WindowEntry[]
  /** Highest-priority advertised state across windows. */
  status: Status | null
  detail: string | null
}

export interface Backend {
  list(): Promise<SessionGroup[]>
  /** Bring the target to this terminal. Blocks until the user comes back. */
  open(target: string): Promise<void>
  /** True when open() retargets in place (no renderer suspend needed). */
  opensInPlace(): boolean
  create(name: string): Promise<void>
  rename(session: string, to: string): Promise<void>
  kill(session: string): Promise<void>
}

/** waiting beats error beats busy beats idle beats unadvertised. */
const PRIORITY: Record<string, number> = { waiting: 4, error: 3, busy: 2, idle: 1 }

export function topStatus(
  items: Array<{ status: Status | null; detail: string | null }>,
): { status: Status | null; detail: string | null } {
  const top = items
    .filter((i) => i.status)
    .sort((a, b) => (PRIORITY[b.status!] ?? 0) - (PRIORITY[a.status!] ?? 0))[0]
  return { status: top?.status ?? null, detail: top?.detail ?? null }
}
