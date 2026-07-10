/**
 * Best-effort focus of the terminal window holding a display target, so the
 * loaded session is actually in front of the user. Layered, all
 * failure-silent (an unfocused-but-loaded session is still a success):
 *   1. xterm window-ops "raise" written straight to the target's tty — the
 *      emulator interprets it if its prefs allow (iTerm: "Terminal may
 *      raise/lower windows"; Ghostty ignores window ops).
 *   2. AppleScript keyed off TERM_PROGRAM captured at registration.
 *      - iTerm2 exposes each session's tty, so we select the exact tab.
 *      - Ghostty terminals don't expose a tty, but we can write to the tty:
 *        stamp a unique title, find the surface by name, call its `focus`
 *        command (raises window + selects tab), then clear the stamp.
 *      - Other known apps get app-level activation (no-op when the picker
 *        is in the same app — they expose no way to select a tab).
 *      First run prompts for Automation permission.
 */
import { writeFileSync } from "node:fs"
import type { DisplayTarget } from "./backend"

const APP_NAMES: Record<string, string> = {
  Apple_Terminal: "Terminal",
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

const ghosttyFocusByName = (marker: string) => `
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      set trm to focused terminal of t
      if name of trm is "${marker}" then focus trm
    end repeat
  end repeat
end tell`

async function osascript(script: string): Promise<void> {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" })
  await proc.exited.catch(() => {})
}

/** Ghostty: stamp the target's title via its tty, focus by name, unstamp. */
async function focusGhostty(tty: string): Promise<void> {
  const marker = `mux-target ${tty}`
  try {
    writeFileSync(tty, `\x1b]0;${marker}\x07`)
  } catch {
    return
  }
  await Bun.sleep(200) // let Ghostty pick up the title before we query it
  await osascript(ghosttyFocusByName(marker))
  try {
    writeFileSync(tty, "\x1b]0;\x07") // back to Ghostty's automatic title
  } catch {}
}

export async function focusTarget(client: DisplayTarget): Promise<void> {
  try {
    writeFileSync(client.tty, "\x1b[5t")
  } catch {}
  if (process.platform !== "darwin" || !client.program) return
  if (client.program === "iTerm.app") return osascript(iTermSelectByTty(client.tty))
  if (client.program === "ghostty") return focusGhostty(client.tty)
  const app = APP_NAMES[client.program]
  if (app) await osascript(`tell application "${app}" to activate`)
}
