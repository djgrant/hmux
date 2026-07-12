# @hmux/hmux

A dashboard for your terminal sessions. One command, no flags, no config:

```
hmux
```

It shows every session and window with **signals advertised by what's running
inside them** — which agent is waiting on you, which is busy, which errored —
and opens sessions in place in whatever terminal you use.

- Type to filter (fuzzy, across sessions and windows). `⏎` opens the top match.
- `↑↓` select · `⏎` open · `⌥↑`/`⌥↓` peek · `^n` new session · `^r` rename (session or window) ·
  `^x` kill · `^c` quit
- `^n` names a session; a name with a slash (`ideas/plato-webdav`) makes a
  window inside that session, creating the session if it's new. Either way you
  land in what you just made, and the cursor is remembered for next time.
- Peek (hold option while arrowing) loads each selection into the display
  target as you pass it, without moving focus off the picker. Needs a
  display target; disabled for `--cc` targets, where every switch rebuilds
  native windows.
- Inside a session you're in plain tmux — your server, your config, your
  plugins. **`prefix d` (detach) returns to hmux.** That's the only tmux you
  need to know.
- hmux respects your setup: with tmux-resurrect installed, sessions survive a
  reboot. Every entrypoint starts by making the substrate ready
  (`Backend.ensure()`), so a dead server is birthed and the last snapshot
  restored before the picker appears; while any hmux process runs (picker or
  parked target) it saves a fresh snapshot every minute, so tmux-continuum
  is not needed. Without resurrect, none of this happens. The server is born
  from the terminal you ran hmux in and inherits its macOS permission grants.
  An empty snapshot leaves an empty picker (`^n` creates the first session).
- `hmux target` parks a terminal as a **display target**: with one open,
  picking a session in hmux loads it into that terminal and the picker stays
  on screen — hmux becomes a window manager across your terminal windows
  (they can even be different apps: one iTerm, one Ghostty). There is one
  target at a time; registering a second offers to kill the first or abort.
  On open, hmux focuses the target's window (xterm raise sequence, plus
  AppleScript on macOS — iTerm and Ghostty get exact tab/window selection,
  even when the picker is in the same app; other terminals get app-level
  activation. The first focus prompts for Automation permission).
- `hmux target --cc` (iTerm only) parks the target as a **tmux control-mode
  gateway**: sessions routed to it open as native iTerm tabs and windows
  rather than rendering inside the parked tab.

Sessions with multiple windows show them as an indented tree; a window's pane
splits are preserved exactly as laid out. While typing, matches flatten into
one ranked list.

## Advertise protocol

hmux is the protocol; tmux is the bundled backend (see `src/backend.ts` for
the seam). hmux never inspects what runs in a pane — processes advertise their
own state, and hmux rolls it up pane → window → session (priority: `error` >
`message` > `busy` > `idle`).

The write path is `hmux advertise`, run from inside the pane in question:

```sh
# I left the human something (detail says what):
hmux advertise --status message --detail "approve the migration plan?"

# I'm working again:
hmux advertise --status busy

# Clear (back to unadvertised):
hmux advertise --clear
```

- `--status` — one word: `message` (the agent needs or left the human
  something; blue ● with the detail as its label), `busy` (amber ●), `error`
  (red ✗), `idle` (an agent is present, at rest; blue ● with no label — plain
  panes advertise nothing and render dim). Freeform tolerated; unknown values
  render dim.
- `--detail` — optional one-line human-readable context. Cleared whenever
  a status is set without one, so a stale annotation cannot outlive the
  status it described. Control characters are stripped at ingress.
- `--agent` — identity of the agent in the pane (e.g. "api-3f2c · sonnet").
  Persists until changed. Ingested but not currently surfaced: the picker
  shows and searches only session and window names.
- `--resume` — the command that brings the pane's occupant back after a
  restore (see below). Persists until changed.

Advertisers need no knowledge of their session name — hmux identifies the
calling pane itself — and the state dies with the pane. Where it is stored is
the backend's business; the tmux backend uses pane user options (`@hmux_status`
and friends), which also work as a direct write path for anything that would
rather speak tmux.

### Resume

A pane that advertises `--resume` gets its occupant back after a reboot.
Snapshot saves copy the advertised resume commands into a manifest
(`~/.local/share/hmux/resume.json`); after a restore rebuilds the panes as
bare shells at their old working directories, hmux types each command into
its pane. Panes matched by session and window name — a rename between save
and restore drops that pane's resume — and only bare shells are typed into,
so a session that already resumed is never typed over.

### Claude Code

[@hmux/cc-plugin](../cc-plugin) advertises automatically: sessions appear
with their agent identity and model, turn `busy` while working, `message`
(with the reason — needs direction, done, permission prompt, a blocking ask)
when the agent has declared something for the human, and `idle` at an
unsignalled rest. It advertises `claude --resume <session-id>` at session
start, so Claude sessions survive a reboot along with their windows. This
works even with no hmux server running; the advertise plane is
independent of the server.

## Development

```
bun run --cwd packages/hmux dev   # run the TUI
bun test                         # from packages/hmux
```
