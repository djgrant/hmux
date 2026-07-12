# hmux

A harness multiplexer: a terminal session dashboard that shows which agents need you, and jumps you to them.

```
hmux
```

Agents advertise their state (busy, waiting on you, errored) from inside their panes; the picker rolls those signals up into one list; you jump into the session that needs you.

See [packages/hmux](packages/hmux) for keybindings and the advertise protocol.

## Packages

- [`hmux`](packages/hmux) — the CLI: session picker, display targets, `hmux advertise` (tmux is the bundled backend)
- [`@hmux/server`](packages/server) — local MCP endpoint (`ask`, `notify`, `signal`, `approve`) plus a WebSocket feed and session roster
- [`@hmux/cc-plugin`](packages/cc-plugin) — Claude Code hooks that register sessions, advertise their status, and wire up the MCP server
- [`@hmux/protocol`](packages/protocol) — shared message types and WebSocket protocol
- [`@hmux/focus`](packages/focus) — focuses the terminal window that owns a given tty
- [`@hmux/mailbox`](packages/mailbox) — terminal inbox for agent messages. Reflects an older model – the picker has largely absorbed its job – and may not stay.
- [`app`](app) — Mac menu-bar app for notifications, server supervision, and setup. Also predates the current model; undecided where it lands.

## Server

```sh
bun run --cwd packages/server start
```

Register agents via the Claude Code plugin, or directly: `claude mcp add --transport http hmux http://localhost:7373/mcp`.
