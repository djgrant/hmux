/**
 * Presence file for the running TUI (~/.humans/tui.json): its tty, terminal
 * program, and pid. `open.ts` reads it to focus the existing TUI window
 * instead of spawning another. Failure-silent throughout — presence is an
 * optimization, never a reason not to render. A stale file (crash, SIGKILL)
 * is harmless: readers verify the pid is alive before trusting it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = process.env.HUMANS_STATE_DIR ?? join(homedir(), ".humans")
export const PRESENCE_PATH = join(STATE_DIR, "tui.json")

export interface TuiPresence {
  tty: string
  program: string | null
  pid: number
  /**
   * Real terminal-focus state from the renderer's focus/blur events, for the
   * menu app's "only notify when the TUI isn't focused" gate (better than its
   * old "any terminal app frontmost" guess). Absent until the first event —
   * not every terminal reports focus — and readers treat absent as unfocused.
   */
  focused?: boolean
}

// The tty as the terminal app knows it. `ps` reports the controlling
// terminal ("ttys012") even where /dev/stdin can't be resolved.
function controllingTty(): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(process.pid)])
    const tty = proc.stdout.toString().trim()
    if (!proc.success || tty === "" || tty === "??") return null
    return tty.startsWith("/dev/") ? tty : `/dev/${tty}`
  } catch {
    return null
  }
}

// TERM_PROGRAM, seen through tmux when needed: inside tmux it reads "tmux",
// but the outer terminal's env fingerprints survive into panes (the tmux
// server inherits the env of the client that started it) — same trick as
// notify.ts uses for notification protocol detection.
function terminalProgram(env: Record<string, string | undefined> = process.env): string | null {
  const program = env.TERM_PROGRAM ?? null
  if (program !== "tmux") return program
  if (env.ITERM_SESSION_ID || /iterm/i.test(env.LC_TERMINAL ?? "")) return "iTerm.app"
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return "ghostty"
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) return "kitty"
  return program
}

/** Record this process as the running TUI; cleared automatically on exit. */
export function announcePresence(): void {
  const tty = controllingTty()
  if (tty === null) return
  const presence: TuiPresence = { tty, program: terminalProgram(), pid: process.pid }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(PRESENCE_PATH, JSON.stringify(presence))
  } catch {
    return
  }
  process.on("exit", () => {
    // Only remove our own record — a TUI started later owns the file now.
    try {
      const current = JSON.parse(readFileSync(PRESENCE_PATH, "utf8")) as TuiPresence
      if (current.pid === process.pid) rmSync(PRESENCE_PATH, { force: true })
    } catch {}
  })
}

/** Update the focus field of our own presence record. */
export function setPresenceFocus(focused: boolean): void {
  try {
    const current = JSON.parse(readFileSync(PRESENCE_PATH, "utf8")) as TuiPresence
    if (current.pid !== process.pid) return
    writeFileSync(PRESENCE_PATH, JSON.stringify({ ...current, focused }))
  } catch {}
}

/** The recorded TUI if its process is still alive, else null. */
export function livePresence(): TuiPresence | null {
  try {
    const presence = JSON.parse(readFileSync(PRESENCE_PATH, "utf8")) as TuiPresence
    if (typeof presence.tty !== "string" || typeof presence.pid !== "number") return null
    process.kill(presence.pid, 0) // throws if the pid is gone
    return presence
  } catch {
    return null
  }
}
