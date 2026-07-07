/**
 * System-notification policy for incoming messages.
 *
 * OpenTUI's `renderer.triggerNotification(message, title?)` handles protocol
 * detection (OSC 9/777/99), tmux/zellij passthrough and sanitization, and
 * returns false when the terminal supports none of them — in which case we
 * fall back to a plain BEL (Terminal.app turns a background bell into a
 * clickable notification; everywhere else it's at worst a harmless ding).
 *
 * Focus gating: the renderer emits "focus"/"blur". We only notify while the
 * terminal is NOT focused — but until the first focus event arrives the state
 * is unknown (not every terminal reports focus), and then we DO notify rather
 * than silently drop everything.
 */

import { stripControls } from "./store"

export type NotifyResult = "os" | "bell" | "skipped"

export interface Notifier {
  /** Wire to the renderer's "focus" event. */
  onFocus(): void
  /** Wire to the renderer's "blur" event. */
  onBlur(): void
  /** Notify unless the terminal is known-focused. */
  notify(body: string, title?: string): NotifyResult
}

export function createNotifier(opts: {
  /** renderer.triggerNotification; returns false when unsupported. */
  trigger: (message: string, title?: string) => boolean
  /** BEL fallback; defaults to writing \x07 to stdout. */
  bell?: () => void
}): Notifier {
  // null = unknown (no focus/blur event seen yet) → treat as unfocused.
  let focused: boolean | null = null
  const bell = opts.bell ?? (() => process.stdout.write("\x07"))
  return {
    onFocus() {
      focused = true
    },
    onBlur() {
      focused = false
    },
    notify(body, title = "humans.sh") {
      if (focused === true) return "skipped"
      if (opts.trigger(body, title)) return "os"
      bell()
      return "bell"
    },
  }
}

// --- tmux: outer-terminal protocol detection ---------------------------------

export type NotificationProtocol = "osc9" | "osc99" | "osc777"

/**
 * Inside tmux, TERM=tmux-256color and TERM_PROGRAM=tmux, so OpenTUI's
 * heuristics can't identify the outer terminal and detect NO notification
 * protocol (triggerNotification returns false → we'd only ever bell, and
 * e.g. iTerm2 doesn't surface a bell as a system notification). But most
 * terminals leave env fingerprints that survive into tmux panes — the tmux
 * server inherits the environment of the client that started it — so we can
 * map those to the protocol the outer terminal speaks.
 *
 * Only fingerprints that (a) survive into tmux and (b) belong to terminals
 * with documented notification support are used; anything else returns null
 * and we keep the BEL fallback.
 */
export function detectTmuxOuterProtocol(
  env: Record<string, string | undefined>,
): NotificationProtocol | null {
  // iTerm2 sets ITERM_SESSION_ID in every session; LC_TERMINAL comes from its
  // shell integration and additionally survives ssh. iTerm2 speaks OSC 9.
  if (env.ITERM_SESSION_ID || /iterm/i.test(env.LC_TERMINAL ?? "")) return "osc9"
  // kitty: the only terminal with the queryable OSC 99 protocol.
  if (env.KITTY_WINDOW_ID || env.KITTY_PID || /kitty/i.test(env.LC_TERMINAL ?? "")) return "osc99"
  // WezTerm, Ghostty and VTE-based terminals (GNOME Terminal, Tilix, …)
  // document the rxvt/VTE-style OSC 777 title+body notification.
  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE || env.WEZTERM_UNIX_SOCKET) return "osc777"
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return "osc777"
  if (env.VTE_VERSION) return "osc777"
  return null
}

/**
 * When running inside tmux (and not zellij), force OpenTUI's notification
 * protocol via the OPENTUI_NOTIFICATION_PROTOCOL env var — OpenTUI reads it
 * at renderer creation with override priority, so call this BEFORE render().
 * A protocol the user already set (including "none"/"off") is respected.
 *
 * NOTE: OpenTUI still wraps the notification OSC in tmux DCS passthrough,
 * which tmux ≥ 3.3 silently drops unless `set -g allow-passthrough on` is in
 * the user's tmux config. That part can't be fixed from inside the pane.
 *
 * Returns the protocol it forced, or null if it left things alone.
 */
export function applyTmuxNotificationOverride(
  env: Record<string, string | undefined> = process.env,
): NotificationProtocol | null {
  if (!env.TMUX || env.ZELLIJ) return null
  if (env.OPENTUI_NOTIFICATION_PROTOCOL) return null
  const protocol = detectTmuxOuterProtocol(env)
  if (protocol) env.OPENTUI_NOTIFICATION_PROTOCOL = protocol
  return protocol
}

/**
 * Deliberately tiny UTF-8 byte budget for the whole notification text.
 *
 * The notification leaves the program as ONE escape sequence (OSC 9/777,
 * tmux-wrapped with doubled ESCs), and OpenTUI's stdout writer silently
 * drops the unwritten tail on partial writes (renderer-output.zig,
 * StdoutOutput.write: `writeAll(data) catch {}` — EAGAIN under frame-storm
 * pipe pressure). A truncated envelope loses its ST terminator; the
 * terminal eventually aborts the OSC and prints the REST OF THE PAYLOAD
 * literally over the UI (round 19b: the tail of a 240-char body strewn
 * across the bottom row, scrolling the screen under the renderer). A small
 * payload keeps the entire wrapped envelope well inside atomic-write
 * territory — and notifications are glanceable one-liners anyway.
 */
export const NOTIFICATION_BYTE_BUDGET = 120

/**
 * Truncate to a UTF-8 byte budget on CODE-POINT boundaries (a blind
 * string.slice can split a surrogate pair, producing mangled bytes
 * mid-payload), appending "…" (3 bytes) when cut.
 */
export function truncateBytes(text: string, budget: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= budget) return text
  let out = ""
  let bytes = 0
  for (const ch of text) {
    const size = encoder.encode(ch).byteLength
    if (bytes + size > budget - 3) break
    out += ch
    bytes += size
  }
  return `${out}…`
}

/**
 * Notification body for a message: `agent: first line`, ANSI sequences and
 * control characters removed, truncated to NOTIFICATION_BYTE_BUDGET bytes.
 */
export function formatNotification(agent: string, body: string): string {
  const firstLine = body.split("\n")[0] ?? ""
  const clean = stripControls(firstLine).trim()
  return truncateBytes(`${agent}: ${clean}`, NOTIFICATION_BYTE_BUDGET)
}
