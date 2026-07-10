/**
 * Best-effort focus of the terminal window holding a display target, so the
 * loaded session is actually in front of the user. Layered, all
 * failure-silent (an unfocused-but-loaded session is still a success):
 *   1. xterm window-ops "raise" written straight to the target's tty — the
 *      emulator interprets it if its prefs allow (iTerm: "Terminal may
 *      raise/lower windows"; Ghostty ignores window ops).
 *   2. AppleScript keyed off TERM_PROGRAM captured at registration. iTerm
 *      and Ghostty get exact tab/window selection: we stamp a unique title
 *      onto the target through its tty, find the session/surface by name,
 *      select it, and clear the stamp. Matching by title rather than tty
 *      survives pty-nesting wrappers (kiro, script, etc.) where the tty the
 *      target sees isn't the one the terminal app knows about. Other known
 *      apps get app-level activation (no-op when the picker is in the same
 *      app — they expose no way to select a tab).
 *      First run prompts for Automation permission.
 */
import { writeFileSync } from "node:fs"
import type { DisplayTarget } from "./backend"

const APP_NAMES: Record<string, string> = {
  Apple_Terminal: "Terminal",
  WezTerm: "WezTerm",
  vscode: "Visual Studio Code",
}

// iTerm may suffix the title (e.g. "… (tmux)"), so match by containment.
const iTermSelectByName = (marker: string) => `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s contains "${marker}" then
          select w
          tell w to select t
          select s
        end if
      end repeat
    end repeat
  end repeat
  activate
end tell`

const ghosttyFocusByName = (marker: string) => `
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      set trm to focused terminal of t
      if name of trm contains "${marker}" then focus trm
    end repeat
  end repeat
end tell`

async function osascript(script: string): Promise<void> {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" })
  await proc.exited.catch(() => {})
}

/** Stamp the target's title via its tty, run the app's find-by-name script, unstamp. */
async function stampAndFocus(tty: string, script: (marker: string) => string): Promise<void> {
  const marker = `mux-target ${tty}`
  try {
    writeFileSync(tty, `\x1b]0;${marker}\x07`)
  } catch {
    return
  }
  await Bun.sleep(200) // let the terminal pick up the title before we query it
  await osascript(script(marker))
  try {
    writeFileSync(tty, "\x1b]0;\x07") // back to the terminal's automatic title
  } catch {}
}

export async function focusTarget(client: DisplayTarget): Promise<void> {
  try {
    writeFileSync(client.tty, "\x1b[5t")
  } catch {}
  if (process.platform !== "darwin" || !client.program) return
  if (client.program === "iTerm.app") return stampAndFocus(client.tty, iTermSelectByName)
  if (client.program === "ghostty") return stampAndFocus(client.tty, ghosttyFocusByName)
  const app = APP_NAMES[client.program]
  if (app) await osascript(`tell application "${app}" to activate`)
}
