/**
 * The backend seam. mux itself is the advertise protocol + dashboard; a
 * backend supplies the three separable roles tmux plays today:
 *   discovery (what sessions/windows exist), signals (advertised state),
 *   and open (how to get there). Other transports can implement this later;
 *   tmux is the bundled default (see tmux.ts).
 */

export type Status = "message" | "busy" | "error" | "idle" | (string & {})

export interface WindowEntry {
  /** Backend-opaque handle passed back to open(). */
  target: string
  session: string
  name: string
  dir: string
  /** Advertised agent identity (e.g. "api-3f2c · sonnet") when a cc session runs here. */
  agent: string | null
  /** Currently selected window within its session. */
  active: boolean
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

/** A terminal parked by `mux target`, identified by its tty. */
export interface DisplayTarget {
  tty: string
  /** TERM_PROGRAM captured at registration (e.g. "iTerm.app", "ghostty"); used to focus it. */
  program: string | null
  /**
   * Client is attached in control mode (iTerm tmux -CC gateway). Its tty
   * carries the %-command protocol: writing any raw bytes to it (escape
   * sequences, title stamps) corrupts the stream and detaches the client.
   */
  controlMode?: boolean
}

export interface Backend {
  /**
   * Make the substrate ready before the first list(): called synchronously at
   * every mux entrypoint. For tmux this is where a dead server after a reboot
   * comes back — birthed and restored from the last snapshot when one exists.
   * Runs in the user's own terminal, so the server it births inherits that
   * terminal's identity (macOS TCC grants ride along). A no-op when the
   * backend is already live; on a genuinely fresh machine it leaves nothing
   * behind and the picker opens empty (^n creates the first session).
   *
   * Ongoing persistence is the backend's own affair: a backend with a
   * persistence mechanism keeps its snapshot fresh for as long as the
   * process lives, so restore always has something recent to replay.
   */
  ensure(): Promise<void>
  list(): Promise<SessionGroup[]>
  /** Bring the target to this terminal. Blocks until the user comes back. */
  open(target: string): Promise<void>
  /** True when open() retargets in place (no renderer suspend needed). */
  opensInPlace(): boolean
  /**
   * Live display targets: terminals that ran `mux target` and are still
   * connected. When one exists, open routes there and the picker stays up.
   */
  targets(): Promise<DisplayTarget[]>
  /** Load target into the given display client (from targets()) and focus it. */
  openInClient(target: string, client: DisplayTarget): Promise<void>
  /** Load target into the display client without taking focus (peek). */
  peekInClient(target: string, client: DisplayTarget): Promise<void>
  /**
   * Create a session, or — when the name carries a slash ("session/window") —
   * a window inside that session, birthing the session first if it's new.
   * Returns the target of whatever was made, ready to hand to open().
   */
  create(name: string): Promise<string>
  /**
   * Remember the picker's cursor across restarts. Server-scoped by nature: the
   * saved target is a pointer into the live sessions, so it lives and dies with
   * the substrate that holds them — no separate lifetime to reconcile.
   */
  saveSelection(target: string): Promise<void>
  loadSelection(): Promise<string | null>
  /** Rename a session ("name") or a window ("name:index"). */
  rename(target: string, to: string): Promise<void>
  /** Kill a session ("name") or a single window ("name:index"). */
  kill(target: string): Promise<void>
}

/** error beats message beats busy beats idle/unadvertised. */
const PRIORITY: Record<string, number> = { error: 3, message: 2, busy: 1, idle: 0 }

export function topStatus(
  items: Array<{ status: Status | null; detail: string | null }>,
): { status: Status | null; detail: string | null } {
  const top = items
    .filter((i) => i.status)
    .sort((a, b) => (PRIORITY[b.status!] ?? 0) - (PRIORITY[a.status!] ?? 0))[0]
  return { status: top?.status ?? null, detail: top?.detail ?? null }
}
