/**
 * Bring the terminal window/tab attached to a tty to the front.
 *
 * The mechanism, stamp-and-focus: write a unique title onto the terminal
 * through its tty (OSC 0), find the tab by that name via the app's scripting
 * interface, select it, clear the stamp. Matching by title rather than tty
 * survives pty-nesting wrappers (kiro, script, ssh-in-a-pty, etc.) where the
 * tty the caller knows isn't the one the terminal app knows about. Only the
 * final "select tab by name" verb is app-specific (each scripting dictionary
 * differs) — see STRATEGIES. Apps without a tab-selection API get app-level
 * activation. Everything is failure-silent: focus is best-effort by design.
 */
import { writeFileSync } from "node:fs"

export interface FocusTarget {
  /** The tty of the terminal to focus, as seen by the process inside it. */
  tty: string
  /** TERM_PROGRAM of that terminal (e.g. "iTerm.app", "ghostty"). */
  program: string | null
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

// Iterate every terminal, not `focused terminal of t`: the target may be an
// unfocused split in a tab (checking only the focused one can never find it).
const ghosttyFocusByName = (marker: string) => `
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with trm in terminals of t
        if name of trm contains "${marker}" then focus trm
      end repeat
    end repeat
  end repeat
  activate
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
 * Apps we can select an exact tab in, keyed by TERM_PROGRAM; anything else
 * falls back to app-level activation. Same stamp, per-app "find tab by name"
 * verb. Others would slot in here: kitty via `kitten @ focus-window --match
 * title:<marker>` (its remote control instead of AppleScript), WezTerm via
 * `wezterm cli activate-pane`, Linux via wmctrl/xdotool title match.
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
  const marker = `hmux-focus ${tty}`
  try {
    writeFileSync(tty, `\x1b]0;${marker}\x07`)
  } catch {
    return
  }
  await osascript(script(marker))
  try {
    writeFileSync(tty, "\x1b]0;\x07") // back to the terminal's automatic title
  } catch {}
}

export async function focusTerminal(target: FocusTarget): Promise<void> {
  // xterm window-ops "raise", honored by some emulators when prefs allow
  // (iTerm: "Terminal may raise/lower windows"; Ghostty ignores window ops).
  try {
    writeFileSync(target.tty, "\x1b[5t")
  } catch {}
  if (process.platform !== "darwin" || !target.program) return
  const strategy = STRATEGIES[target.program]
  if (strategy) return stampAndFocus(target.tty, strategy)
  const app = APP_NAMES[target.program]
  if (app) await osascript(`tell application "${app}" to activate`)
}
