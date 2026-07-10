# @humans/mux

A dashboard for your terminal sessions. One command, no flags, no config:

```
mux
```

It shows every session and window with **signals advertised by what's running
inside them** — which agent is waiting on you, which is busy, which errored —
and opens sessions in place in whatever terminal you use.

- Type to filter (fuzzy, across sessions and windows). `⏎` opens the top match.
- `↑↓` select · `⏎` open · `^n` new session · `^r` rename · `^x` kill · `^c` quit
- Inside a session you're in plain tmux — your server, your config, your
  plugins. **`prefix d` (detach) returns to mux.** That's the only tmux you
  need to know.
- `mux <name>` jumps straight into the best-matching session.
- `mux target` parks a terminal as a **display target**: with one open,
  picking a session in mux loads it into that terminal and the picker stays
  on screen — mux becomes a window manager across your terminal windows
  (they can even be different apps: one iTerm, one Ghostty).

Sessions with multiple windows show them as an indented tree; a window's pane
splits are preserved exactly as laid out. While typing, matches flatten into
one ranked list.

## Advertise protocol

mux is the protocol; tmux is the bundled backend (see `src/backend.ts` for
the seam). mux never inspects what runs in a pane — processes advertise their
own state by setting tmux **pane user options**, and mux rolls them up
pane → window → session (priority: `waiting` > `error` > `busy` > `idle`).

From inside the pane in question:

```sh
# I need a human:
tmux set-option -p @humans_status waiting
tmux set-option -p @humans_detail "approve the migration plan?"

# I'm working again:
tmux set-option -p @humans_status busy

# Clear (back to unadvertised):
tmux set-option -pu @humans_status
tmux set-option -pu @humans_detail
```

- `@humans_status` — one word: `waiting`, `busy`, `error`, `idle` (freeform
  tolerated; unknown values render dim).
- `@humans_detail` — optional one-line human-readable context. Control
  characters are stripped at ingress.
- `@humans_agent` — optional identity of the agent in the pane (e.g.
  "api-3f2c · sonnet"), shown as row metadata and searchable in typeahead.
- `-p` (pane-level) means the advertiser needs no knowledge of its session
  name, and the state dies with the pane.

### Claude Code

[@humans/cc-plugin](../cc-plugin) advertises automatically: sessions appear
with their agent identity and model, turn `busy` while working, and `waiting`
(with the reason — permission prompt, awaiting reply) whenever a human is
needed. This works even with no humans.sh server running; the tmux options
are a second, server-independent signal plane.

## Development

```
bun run --cwd packages/mux dev   # run the TUI
bun test                         # from packages/mux
```
