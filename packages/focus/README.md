# terminal-focus

Brings the terminal window or tab attached to a tty to the front – switching tabs inside an app, or across apps, as needed.

## Quick start

```ts
import { focusTerminal } from "terminal-focus";

await focusTerminal({ tty: "/dev/ttys012", program: "iTerm.app" });
```

Or from a shell:

```sh
terminal-focus /dev/ttys012 iTerm.app
```

## Supported terminals

| TERM_PROGRAM     | Granularity |
| ---------------- | ----------- |
| `iTerm.app`      | exact tab   |
| `ghostty`        | exact tab   |
| `Apple_Terminal` | exact tab   |
| `WezTerm`        | app-level   |
| `vscode`         | app-level   |
| anything else    | raise only  |

macOS only, beyond the raise sequence. Focus is best-effort, so a missed focus should be treated as cosmetic. The first focus per app pair triggers a macOS Automation prompt; until granted, the scripting strategies no-op.
