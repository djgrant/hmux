# hmux Codex plugin

A Codex plugin that gives sessions live presence on a local [hmux](../..) server and routes the agent's questions and progress through the human inbox. It is the Codex counterpart to [`hmux-cc-plugin`](../cc-plugin) and [`hmux-pi-plugin`](../pi-plugin).

Requires [Bun](https://bun.sh), Codex 0.144 or newer, and an hmux server on `http://localhost:7373` (set `HMUX_URL` to override). If hmux is unavailable, the hooks fail silently and never interrupt the session.

## Install

```sh
codex plugin marketplace add https://github.com/djgrant/hmux
codex plugin add hmux@hmux
```

Codex asks you to review and trust the plugin's hooks when they first load.

## What it does

| Codex event | hmux behaviour |
|-------------|----------------|
| `SessionStart` | register the session, advertise it at rest, and publish its resume command and transcript |
| `UserPromptSubmit` | mark the session busy and inject the bound-session workflow |
| `PreToolUse` | stamp hmux calls with the harness-provided session id and surface blocking questions |
| `PostToolUse` | heartbeat and pick up a mid-turn inbox binding |
| `SubagentStop` | keep the parent session busy |
| `Stop` | promote a declared question/done signal, otherwise rest at idle |

The MCP tools are `mcp__hmux__ask`, `mcp__hmux__notify`, `mcp__hmux__signal`, and `mcp__hmux__approve`.
