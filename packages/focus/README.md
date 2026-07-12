# @hmux/focus

Brings the terminal window or tab attached to a tty to the front, even when that means switching tabs inside an app, or the terminal belongs to a different app than the caller.

## Quick start

```ts
import { focusTerminal } from "@hmux/focus"

await focusTerminal({ tty: "/dev/ttys012", program: "iTerm.app" })
```

Or from anything that can run a shell:

```sh
hmux-focus /dev/ttys012 iTerm.app
```

## How it works

A marker title is written to the tty (`OSC 0`), the tab now bearing that title is selected through the app's scripting interface, and the marker is cleared. Matching on the title rather than the tty is what makes this reliable: pty-nesting wrappers (kiro, `script`) give the inner process a different tty from the one the terminal app reports, but a title written to either arrives at the same tab.

The marker embeds the tty, so a title collision can only cause a missed focus, never a wrong tab. A short delay (350ms) sits between stamp and select, giving the title time to land and any in-flight redraw (a tmux `switch-client`, say) time to finish painting.

An xterm raise sequence (`ESC [ 5 t`) is written first. It costs nothing, and some emulators honour it directly.

## Supported terminals

| TERM_PROGRAM     | Granularity  | Mechanism                                           |
| ---------------- | ------------ | --------------------------------------------------- |
| `iTerm.app`      | exact tab    | AppleScript: session `name` match, then `select`    |
| `ghostty`        | exact tab    | AppleScript: terminal `name` match, then `focus`    |
| `Apple_Terminal` | exact tab    | AppleScript: tab `custom title` match, then `selected` |
| `WezTerm`        | app-level    | `activate` (tab selection via `wezterm cli` is possible) |
| `vscode`         | app-level    | `activate`                                          |
| anything else    | raise-escape | no scripting attempted                              |

Adding a terminal is one entry in `STRATEGIES` (`src/index.ts`). The stamp is shared; only the "find tab by name and select it" verb differs per app. It does not have to be AppleScript: kitty would use `kitten @ focus-window --match title:<marker>`, and Linux would use wmctrl or xdotool title matching.

## Caveats

- Focus is best-effort. Every step is failure-silent, so callers should treat a missed focus as cosmetic rather than an error.
- The first focus per calling-app and terminal-app pair triggers a macOS Automation prompt. Until granted, the AppleScript strategies silently no-op. An app controlling itself ("iTerm2 wants to control iTerm2") is a separate grant from controlling another app.
- The marker is visible in the tab bar for the settle period (roughly 350ms). Programs that continuously rewrite the title (tmux with `set-titles on`) can race the stamp; the worst case is a missed focus.
- macOS only, beyond the raise sequence.
