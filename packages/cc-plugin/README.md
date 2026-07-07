# @humans/cc-plugin

A Claude Code plugin that gives your Claude Code sessions live presence on a
local [humans.sh](../..) server, and lets the human "bind" a session so the
agent routes questions and progress updates through the human's inbox.

Requires [Bun](https://bun.sh) (the hook script runs with `bun`) and a
humans.sh server on `http://localhost:7373` (set `HUMANS_URL` to override).
If the server is down, every hook fails silently — your session is never
affected.

## Install locally

The quickest way, straight from this repo (no install step):

```sh
claude --plugin-dir /path/to/humans.sh/packages/cc-plugin
```

Or install it persistently via a local marketplace. Create a
`marketplace.json` somewhere, e.g. `~/humans-marketplace/.claude-plugin/marketplace.json`:

```json
{
  "name": "humans",
  "owner": { "name": "you" },
  "plugins": [
    { "name": "humans", "source": "/path/to/humans.sh/packages/cc-plugin" }
  ]
}
```

Then inside Claude Code:

```
/plugin marketplace add ~/humans-marketplace
/plugin install humans@humans
```

Note: marketplace installs are copied into `~/.claude/plugins/cache`, so
re-install (or use `--plugin-dir` during development) to pick up changes.
`/reload-plugins` reloads a `--plugin-dir` plugin without restarting.

## What it does

All six hooks run one script, [`src/hook.ts`](src/hook.ts), which reads the
hook JSON from stdin and talks plain HTTP to the humans.sh server:

| Hook | Effect |
| --- | --- |
| `SessionStart` | Registers the session: `POST /sessions/register` with the session id, `project` (the cwd), `model`, and an agent name derived from the cwd's last path segment plus a short session-id suffix (e.g. `humans.sh-a1b2`). |
| `UserPromptSubmit` | Marks the session `working`, then checks the session's `bound` flag (`GET /sessions/:id`). If the human has bound the session from the TUI, it injects `additionalContext` telling the agent to use `mcp__humans__ask` for questions/decisions and `mcp__humans__notify` for progress — and to pass its roster `agent`/`project` on every call so inbox messages correlate with the roster entry. |
| `PostToolUse` | Heartbeat: marks the session `working` after every tool call, keeping actively-working agents fresh in the roster. Also picks up mid-task binds: when the session is bound and the context hasn't been injected into this conversation yet (tracked via a marker file in `~/.humans/`), it injects the same bound context once. Unbinding clears the marker so a re-bind re-injects. |
| `Stop` | Marks the session `idle`. |
| `Notification` | Marks the session `needs-attention` (permission prompts, idle prompts). |
| `SessionEnd` | Marks the session ended: `POST /sessions/:id/end`. |

Every status update bumps the session's `lastSeen`; staleness is computed by
consumers (the TUI), not the server.

Note on idle sessions: Claude Code has no periodic hook, so a session sitting
idle at the prompt genuinely cannot heartbeat — its `lastSeen` freezes at the
last Stop. The TUI therefore keeps stale sessions listed (marked as "possibly
gone" with a hollow marker) rather than dropping them, only pruning sessions
silent for hours.

The plugin also declares the humans MCP server ([`.mcp.json`](.mcp.json))
pointing at `http://localhost:7373/mcp`, so the `ask`/`notify` tools are
available whenever the plugin is enabled.

Heads-up: a bound session's FIRST `mcp__humans__ask`/`mcp__humans__notify`
call may hit a Claude Code permission prompt (which the TUI surfaces as
needs-attention). Allow the humans tools once — e.g. "always allow" when
prompted — so bound agents can reach your inbox unattended.
