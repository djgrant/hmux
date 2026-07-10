/**
 * Best-effort focus of the terminal window holding a display target, so the
 * loaded session is actually in front of the user. Two layers, both
 * failure-silent (an unfocused-but-loaded session is still a success):
 *   1. xterm window-ops "raise" written straight to the target's tty — the
 *      emulator interprets it if its prefs allow (iTerm: "Terminal may
 *      raise/lower windows"; Ghostty ignores window ops).
 *   2. AppleScript keyed off TERM_PROGRAM captured at registration. iTerm2
 *      exposes each session's tty, so we select the exact tab; other apps
 *      get app-level activation. First run prompts for Automation permission.
 */
import { writeFileSync } from "node:fs"
import type { DisplayTarget } from "./backend"

const APP_NAMES: Record<string, string> = {
  "iTerm.app": "iTerm2",
  Apple_Terminal: "Terminal",
  ghostty: "Ghostty",
  WezTerm: "WezTerm",
  vscode: "Visual Studio Code",
}

const iTermSelectByTty = (tty: string) => `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select w
          tell w to select t
          select s
        end if
      end repeat
    end repeat
  end repeat
  activate
end tell`

function osascript(script: string): void {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" })
  proc.exited.catch(() => {})
}

export function focusTarget(client: DisplayTarget): void {
  try {
    writeFileSync(client.tty, "\x1b[5t")
  } catch {}
  if (process.platform !== "darwin" || !client.program) return
  if (client.program === "iTerm.app") {
    osascript(iTermSelectByTty(client.tty))
    return
  }
  const app = APP_NAMES[client.program]
  if (app) osascript(`tell application "${app}" to activate`)
}
