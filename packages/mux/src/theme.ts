/** Palette mirrors @humans/tui so the two apps read as siblings. */
export const BODY = "#c9c9c9"
export const BRIGHT = "#ffffff"
export const DIM = "#9a9a9a"
export const FAINT = "#6f6f6f"
export const GUTTER = "#4a4a4a"
export const HIGHLIGHT_BG = "#3a3a3a"
export const SIDEBAR_BG = "#0a0a0a"
export const MAIN_BG = "#151a1d"
/**
 * Advertised-status accents. Amber for busy (work in progress, not "all
 * good" — green would read as done), blue for waiting (calm "your turn",
 * distinct from the alarm colors), red for error.
 */
export const WAITING = "#6fa3d8"
export const BUSY = "#d8a15f"
export const ERROR = "#d87070"

export function statusColor(status: string | null): string {
  if (status === "waiting") return WAITING
  if (status === "error") return ERROR
  if (status === "busy") return BUSY
  return FAINT
}

export function statusGlyph(status: string | null, attached: boolean): string {
  if (status === "waiting") return "◉"
  if (status === "error") return "✗"
  if (status === "busy") return "●"
  return attached ? "●" : "○"
}
