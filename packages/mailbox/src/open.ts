#!/usr/bin/env bun
/**
 * Open-or-focus the TUI. This is what the menu bar app runs for "Open TUI"
 * and notification taps:
 *
 *   - a TUI is already running (live presence file) -> focus its terminal
 *     window/tab via terminal-focus and stop
 *   - otherwise -> launch it in a new iTerm window (Terminal.app fallback)
 *
 * The launch AppleScript lives here rather than in the Swift app so both
 * behaviours ship and evolve together. iTerm's `command` parameter doesn't
 * shell-parse, hence `write text` into the fresh window's session.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { focusTerminal } from "terminal-focus"
import { livePresence } from "./presence"

const live = livePresence()
if (live) {
  await focusTerminal({ tty: live.tty, program: live.program })
  process.exit(0)
}

const tuiDir = join(import.meta.dir, "..")
const run = `cd ${tuiDir} && exec bun run src/index.tsx`

const script = existsSync("/Applications/iTerm.app")
  ? [
      `tell application "iTerm" to activate`,
      `tell application "iTerm" to tell current session of (create window with default profile) to write text "${run}"`,
    ]
  : [
      `tell application "Terminal" to activate`,
      `tell application "Terminal" to do script "${run}"`,
    ]

const proc = Bun.spawn(["osascript", ...script.flatMap((line) => ["-e", line])], {
  stdout: "ignore",
  stderr: "ignore",
})
await proc.exited.catch(() => {})
