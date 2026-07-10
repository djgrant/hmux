/**
 * Best-effort focus of the terminal window holding a display target, so the
 * loaded session is actually in front of the user. Layered, all
 * failure-silent (an unfocused-but-loaded session is still a success):
 *   1. xterm window-ops "raise" written straight to the target's tty — the
 *      emulator interprets it if its prefs allow (iTerm: "Terminal may
 *      raise/lower windows"; Ghostty ignores window ops).
 *   2. One general mechanism, stamp-and-focus: write a unique title onto the
 *      target through its tty, find the tab by name via the app's scripting
 *      interface, select it, clear the stamp. Matching by title rather than
 *      tty survives pty-nesting wrappers (kiro, script, etc.) where the tty
 *      the target sees isn't the one the terminal app knows about. Only the
 *      final "select by name" verb is app-specific (each scripting
 *      dictionary differs) — see STRATEGIES. Apps without a tab-selection
 *      API get app-level activation (no-op when the picker is in the same
 *      app). First run prompts for macOS Automation permission.
 */
import { writeFileSync } from "node:fs"
import type { DisplayTarget } from "./backend"

// The stamp delay does double duty: lets the terminal ingest the new title,
// and lets tmux finish redrawing the switched session so the tab doesn't
// come forward mid-paint (visible flash in Ghostty).
const SETTLE_MS = 350

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

// Terminal.app reflects the OSC title into `custom title of tab`.
const terminalAppSelectByName = (marker: string) => `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t contains "${marker}" then
        set selected of t to true
        set index of w to 1
        set frontmost of w to true
      end if
    end repeat
  end repeat
  activate
end tell`

/**
 * Apps we can select an exact tab in; anything else falls back to activate.
 * Same stamp, per-app "find tab by name" verb. Others would slot in here:
 * kitty via `kitten @ focus-window --match title:<marker>` (its remote
 * control instead of AppleScript), WezTerm via `wezterm cli activate-pane`,
 * Linux via wmctrl/xdotool title match.
 */
const STRATEGIES: Record<string, (marker: string) => string> = {
  "iTerm.app": iTermSelectByName,
  ghostty: ghosttyFocusByName,
  Apple_Terminal: terminalAppSelectByName,
}

/** Apps with no tab-selection API: bring the app forward, best we can do. */
const APP_NAMES: Record<string, string> = {
  WezTerm: "WezTerm",
  vscode: "Visual Studio Code",
}

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
  await Bun.sleep(SETTLE_MS)
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
  const strategy = STRATEGIES[client.program]
  if (strategy) return stampAndFocus(client.tty, strategy)
  const app = APP_NAMES[client.program]
  if (app) await osascript(`tell application "${app}" to activate`)
}
