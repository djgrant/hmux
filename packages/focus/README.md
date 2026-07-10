# @humans/focus

Brings the terminal window or tab attached to a tty to the front, even when that means switching tabs inside an app, or the terminal belongs to a different app than the caller.

## Quick start

```ts
import { focusTerminal } from "@humans/focus"

await focusTerminal({ tty: "/dev/ttys012", program: "iTerm.app" })
```

Or from anything that can run a shell:

```sh
humans-focus /dev/ttys012 iTerm.app
```

## How it works

No macOS API focuses "the tab attached to this tty". Asking apps for their ttys is unreliable too: pty-nesting wrappers (kiro, `script`, anything that re-terms a shell) give the inner process a different tty from the one the terminal app knows about.

Instead, the terminal is made to identify itself:

1. A unique marker title is written through the tty (`OSC 0`). A terminal has to forward output to be a terminal, so the stamp survives any wrapper in between.
2. A short settle delay lets the title land. It also lets whatever just redrew the terminal (a tmux `switch-client`, say) finish painting before the tab comes forward.
3. The tab whose title contains the marker is found via the app's scripting interface and selected.
4. The stamp is cleared and the terminal reverts to its automatic title.

Matching is by containment because some apps decorate titles (iTerm appends "(tmux)"). The marker embeds the tty, so a title collision can only cause a missed focus, not a wrong tab.

Before any of that, an xterm raise sequence (`ESC [ 5 t`) is written to the tty. It costs nothing, and some emulators honour it when their preferences allow.

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
