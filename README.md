# hmux

A harness multiplexer: a dashboard for your terminal sessions that shows which agents need you, and jumps you straight to them.

The core loop: agents advertise their state (busy, waiting on you, errored) from inside their panes; the `hmux` picker rolls those signals up into one list; you jump into the session that needs you and answer with full context.

```
hmux
```

See [packages/hmux](packages/hmux) for the picker, keybindings, and the advertise protocol.

## Packages

- [`hmux`](packages/hmux) — the CLI: session picker, display targets, and the `hmux advertise` signal plane (tmux is the bundled backend)
- [`@hmux/server`](packages/server) — local coordination server: an MCP endpoint (`ask`, `notify`, `signal`, `approve`) agents call to reach you, plus a WebSocket feed and session roster
- [`@hmux/cc-plugin`](packages/cc-plugin) — Claude Code plugin: hooks that register sessions, advertise their status into hmux, and wire up the MCP server
- [`@hmux/protocol`](packages/protocol) — shared message types and WebSocket protocol
- [`@hmux/focus`](packages/focus) — focuses the terminal window that owns a given tty (used to bring a session's window forward)

## Older surfaces

Two parts of the repo still reflect the original humans.sh model – a detached inbox you read messages in, rather than a picker you jump to sessions from. I'm not yet sure where they'll land:

- [`@hmux/mailbox`](packages/mailbox) — the terminal inbox for reading and answering agent messages. The picker has largely absorbed its job; if a message-history surface returns, it likely belongs inside the picker.
- [`app`](app) — a native Mac menu-bar app that owns notifications, server supervision, and first-run setup. Its jobs are still real, but it predates the hmux naming and isn't wired into the current flow.

## Running the server

```sh
bun run --cwd packages/server start
```

Agents register via the Claude Code plugin, or directly: `claude mcp add --transport http hmux http://localhost:7373/mcp`.
