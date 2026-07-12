# hmux

A harness multiplexer built on top of tmux: jump between your agent sessions and see what's happening inside them.

## Install

```sh
npm install -g @djgrant/hmux
```

## Usage

```sh
hmux          # the picker; also starts the MCP server when it isn't running
hmux target   # a terminal to open picked sessions into (optional)
```

The picker lists every session and window, each tagged with the status the process inside advertises about itself – waiting on you, busy, errored, idle. Type to filter (fuzzy, across sessions and windows); `⏎` opens the top match.

Keys: `↑↓` select · `⏎` open · `⌥↑`/`⌥↓` peek · `^n` new session · `^r` rename · `^x` kill · `^c` quit.

Inside a session you are in plain tmux – your server, your config. `prefix d` (detach) returns to hmux.

## Advertise

hmux never inspects what runs in a pane. Processes advertise their own state, and hmux rolls it up from pane to window to session. Run this from inside the pane:

```sh
hmux advertise --status message --detail "approve the migration plan?"
hmux advertise --status busy
hmux advertise --clear
```

`--status` is one word (`message`, `busy`, `error`, `idle`); `--detail` is optional one-line context.

Claude Code advertises automatically via [hmux-cc-plugin](../cc-plugin). See the [repo README](../..) for the wider picture.
