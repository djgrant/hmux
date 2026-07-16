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

- [`@djgrant/hmux`](packages/hmux) — the CLI (installs the `hmux` binary): session picker, display targets, `hmux advertise` (tmux is the bundled backend)
- [`@hmux/server`](packages/server) — local MCP endpoint (`ask`, `notify`, `signal`, `approve`) plus a WebSocket feed and session roster
- [`hmux-cc-plugin`](packages/cc-plugin) — Claude Code hooks that register sessions, advertise their status, and wire up the MCP server
- [`hmux Codex plugin`](packages/codex-plugin) — Codex hooks and MCP wiring for the same live presence and human-in-the-loop workflow
- [`hmux-pi-plugin`](packages/pi-plugin) — pi extension with native lifecycle events and human-in-the-loop tools
- [`@hmux/protocol`](packages/protocol) — shared message types and WebSocket protocol
- [`terminal-focus`](packages/focus) — focuses the terminal window that owns a given tty
- [`@hmux/mailbox`](packages/mailbox) — terminal inbox for agent messages. Reflects an older model – the picker has largely absorbed its job – and may not stay.
- [`app`](app) — Mac menu-bar app for notifications, server supervision, and setup. Also predates the current model; undecided where it lands.

## Integrations

Harness plugins enrich the picker with agents status.

Claude Code, Codex, and pi are supported via their respective harness plugins.

Install it into Claude Code:

```sh
claude plugin marketplace add djgrant/hmux
claude plugin install hmux@hmux
```

Install it into Codex:

```sh
codex plugin marketplace add https://github.com/djgrant/hmux
codex plugin add hmux@hmux
```

Install it into pi:

```sh
pi install git:github.com/djgrant/hmux
```

Other harnesses can register with the MCP server directly: `claude mcp add --transport http hmux http://localhost:7373/mcp`.

## Development

The repo uses pnpm workspaces (with bun as the runtime) and dogfoods [pok](https://github.com/djgrant/pok) as its dev-tooling launcher:

```sh
pnpm install
pok build       # build all packages
pok test        # run the test suite
pok typecheck   # typecheck all packages
```

### Releasing

`@djgrant/hmux` and `terminal-focus` are published to npm. The harness plugins ship through their native plugin systems; `@hmux/protocol`, `@hmux/server`, and `@hmux/mailbox` are bundled or private.

```sh
pok version     # bumpp: bump the publishable packages, commit, tag v<x.y.z>, push
```

Pushing the `v*` tag triggers the Release workflow, which publishes to npm and cuts a GitHub Release. To publish from your machine instead, run `npm login` then `pok publish` (`pok publish --dry-run` to preview).
