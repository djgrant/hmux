# @humans/focus

Bring the terminal window/tab attached to a tty to the front — even when
that means switching tabs inside an app, or the terminal is a different app
than the caller.

```ts
import { focusTerminal } from "@humans/focus"

await focusTerminal({ tty: "/dev/ttys012", program: "iTerm.app" })
```

Or from anything that can run a shell (the menu app, scripts):

```sh
humans-focus /dev/ttys012 iTerm.app
```

`program` is the target terminal's `TERM_PROGRAM` — capture it *inside* the
terminal you'll later want to focus, alongside its `tty`.

## How it works: stamp-and-focus

There is no OS-level "focus the tab attached to this tty" API, and asking
apps for their ttys is unreliable: pty-nesting wrappers (kiro, `script`,
anything that re-terms the shell) mean the tty a process sees is often not
the tty the terminal app knows about. So instead of matching ttys, we make
the terminal identify itself:

1. Write a unique marker title through the tty (`OSC 0`). A terminal must
   forward output, so the stamp survives any wrapper in between.
2. Wait briefly (`SETTLE_MS`) for the title to land — and for whatever just
   redrew the terminal (e.g. a tmux `switch-client`) to finish painting, so
   the tab doesn't come forward mid-paint.
3. Find the tab whose title contains the marker via the app's scripting
   interface and select it.
4. Clear the stamp; the terminal reverts to its automatic title.

Matching is by containment (iTerm suffixes titles with " (tmux)"), and the
marker embeds the tty, so a collision can only cause a missed focus — never
focusing the wrong tab.

Before any of that, an xterm window-ops raise (`ESC [ 5 t`) is written to
the tty: free to try, honored by some emulators when their prefs allow it.

## Supported terminals

| TERM_PROGRAM     | Granularity  | Mechanism                                        |
| ---------------- | ------------ | ------------------------------------------------ |
| `iTerm.app`      | exact tab    | AppleScript: session `name` match → `select`     |
| `ghostty`        | exact tab    | AppleScript: terminal `name` match → `focus`     |
| `Apple_Terminal` | exact tab    | AppleScript: tab `custom title` match → `selected` |
| `WezTerm`        | app-level    | `activate` (tab selection via `wezterm cli` TBD) |
| `vscode`         | app-level    | `activate`                                       |
| anything else    | raise-escape | only step 0; no scripting attempted              |

Adding a terminal is one entry in `STRATEGIES` (src/index.ts): the stamp is
shared, only the "find tab by name, select it" verb differs. It doesn't have
to be AppleScript — kitty would use `kitten @ focus-window --match
title:<marker>`, Linux would use wmctrl/xdotool title matching.

## Caveats

- **Best-effort by design.** Every step is failure-silent; callers should
  treat "didn't focus" as cosmetic, never as an error.
- **macOS Automation permission.** The first focus per (calling app →
  terminal app) pair triggers a TCC prompt; until granted, AppleScript
  strategies silently no-op. App-to-itself ("iTerm2 wants to control
  iTerm2") is a separate grant from app-to-other.
- **Title blip.** The marker is visible in the tab bar for ~`SETTLE_MS`.
  Programs that continuously rewrite the title (tmux with `set-titles on`)
  can race the stamp; worst case is a missed focus.
- **macOS only** beyond the raise-escape, for now.
