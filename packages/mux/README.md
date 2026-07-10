# @humans/mux

A tmux session router. Runs in any terminal, shows every session (name, dir,
windows, attached state) with a live peek at the selected session's active
pane, and opens sessions in place — no iTerm, no menu bar.

```
bun run --cwd packages/mux dev
```

## Opening a session

- **Inside tmux** (recommended: give the router its own session/pane): ⏎ runs
  `tmux switch-client` — this client retargets, the router keeps running.
- **Outside tmux**: the TUI suspends, hands the terminal to `tmux attach`, and
  resumes when you detach (`prefix d`).

## Keys

`↑↓`/`jk` select · `⏎` open · `n` new session · `r` rename · `x` kill · `q` quit

## Advertise protocol

Control is inverted: mux knows nothing about what runs in a pane. Any process
can advertise its state by setting tmux **pane user options**; mux reads them
back and rolls them up to a per-session badge (priority: `waiting` > `error` >
`busy` > `idle`).

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
- Options are set with `-p` (pane-level), so the advertiser needs no knowledge
  of its session name and the state dies with the pane.

### Claude Code example

`~/.claude/settings.json` hooks that badge the session whenever Claude is
waiting for input and clear it when work resumes:

```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "[ -n \"$TMUX\" ] && tmux set-option -p @humans_status waiting; :" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "[ -n \"$TMUX\" ] && tmux set-option -p @humans_status waiting && tmux set-option -p @humans_detail \"claude finished — awaiting you\"; :" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "[ -n \"$TMUX\" ] && tmux set-option -p @humans_status busy && tmux set-option -pu @humans_detail; :" }] }]
  }
}
```
