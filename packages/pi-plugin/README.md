# hmux-pi-plugin

A [pi](https://pi.dev) extension that gives your pi sessions live presence on a local [hmux](../..) server: each session advertises its identity and status, and the human can route an agent's questions and progress through their inbox. It is the pi-harness counterpart to [`hmux-cc-plugin`](../cc-plugin).

Requires an hmux server on `http://localhost:7373` (set `HMUX_URL` to override). If the server is down, every call fails silently, so your session is never affected. The signal-plane presence (roster status in `hmux`) additionally needs the `hmux` CLI on your `PATH` and a tmux pane.

## Install

```sh
pi install git:github.com/djgrant/hmux
```

Or, for local development, load it straight from a checkout:

```sh
pi -e /path/to/hmux/packages/pi-plugin
```

## What it does

Where the Claude Code plugin uses hooks, this uses pi's extension events. The mapping is one-to-one:

| pi event | hmux behaviour |
|----------|----------------|
| `session_start` | register the session; advertise it at rest (`idle`); publish a `pi --session <id>` resume command and the session transcript path |
| `before_agent_start` | turn the pane `busy`, mark the server session `working`, inject the bound-session context once when bound |
| `tool_execution_end` | heartbeat (`busy` + refresh `last_seen`); pick up a mid-task bind |
| `agent_settled` | promote a declared turn-end signal (`question` → needs-attention, `done` → idle), else rest at `idle` |
| `session_shutdown` | end the server session and clear the pane |

pi [intentionally has no built-in MCP](https://pi.dev), so the tools the CC plugin declared via `.mcp.json` are **registered natively** here and proxied to the hmux server:

- **`hmux_ask`** — ask the human and block until they answer.
- **`hmux_notify`** — send an FYI notification; returns immediately.
- **`hmux_signal`** — declare how the turn ends (`question` / `done`) so the dashboard can label it.

Because these are the extension's own tools, they carry the pi session id directly — no identity-stamping hook is needed to keep attribution honest.

There is no `approve` tool: it exists in the CC plugin only to serve Claude Code's headless `--permission-prompt-tool` contract, which pi does not have.

See the [repo README](../..) for the wider picture.
