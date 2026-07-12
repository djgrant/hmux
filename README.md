# hmux

A harness multiplexer built on top of tmux. 

### Features

- Quickly jump between your agent sessions
- Get a high-level overview of what's happening inside them

## Usage

```sh
hmux          # the picker; also starts the MCP server when it isn't running
hmux target   # the terminal the picker opens into (optional)
```

## Packages

- [`hmux`](packages/hmux) — the CLI: session picker, display targets, `hmux advertise` (tmux is the bundled backend)
- [`@hmux/server`](packages/server) — local MCP endpoint (`ask`, `notify`, `signal`, `approve`) plus a WebSocket feed and session roster
- [`@hmux/cc-plugin`](packages/cc-plugin) — Claude Code hooks that register sessions, advertise their status, and wire up the MCP server
- [`@hmux/protocol`](packages/protocol) — shared message types and WebSocket protocol
- [`@hmux/focus`](packages/focus) — focuses the terminal window that owns a given tty
- [`@hmux/mailbox`](packages/mailbox) — terminal inbox for agent messages. Reflects an older model – the picker has largely absorbed its job – and may not stay.
- [`app`](app) — Mac menu-bar app for notifications, server supervision, and setup. Also predates the current model; undecided where it lands.

## Integrations

Currently, only Claude Code is supported, via [`@hmux/cc-plugin`](packages/cc-plugin). The plugin's hooks give every session a presence in the picker without the agent doing anything:

- Registers each session in the roster on start, with an agent name derived from its cwd.
- Advertises live status into the session's row – busy while working, what it's asking when it asks, "needs direction" or "done" at turn end.
- When you bind a session, injects context telling the agent to route questions (`ask`) and progress (`notify`) through the MCP server.

Install it from this repo:

```sh
claude plugin marketplace add /path/to/hmux
claude plugin install hmux@hmux
```

Other harnesses can register with the MCP server directly: `claude mcp add --transport http hmux http://localhost:7373/mcp`.
