# @hmux/cc-plugin

A Claude Code plugin that gives your Claude Code sessions live presence on a
local [hmux](../..) server, and lets the human "bind" a session so the
agent routes questions and progress updates through the human's inbox.

Requires [Bun](https://bun.sh) (the hook script runs with `bun`) and a
hmux server on `http://localhost:7373` (set `HMUX_URL` to override).
If the server is down, every hook fails silently — your session is never
affected.

## Install locally

The quickest way, straight from this repo (no install step):

```sh
claude --plugin-dir /path/to/hmux/packages/cc-plugin
```

Or install it persistently via a local marketplace. Create a
`marketplace.json` somewhere, e.g. `~/hmux-marketplace/.claude-plugin/marketplace.json`:

```json
{
  "name": "hmux",
  "owner": { "name": "you" },
  "plugins": [
    { "name": "hmux", "source": "/path/to/hmux/packages/cc-plugin" }
  ]
}
```

Then inside Claude Code:

```
/plugin marketplace add ~/hmux-marketplace
/plugin install hmux@hmux
```

Note: marketplace installs are copied into `~/.claude/plugins/cache`, so
re-install (or use `--plugin-dir` during development) to pick up changes.
`/reload-plugins` reloads a `--plugin-dir` plugin without restarting.

## What it does

All six hooks run one script, [`src/hook.ts`](src/hook.ts), which reads the
hook JSON from stdin and talks plain HTTP to the hmux server:

| Hook | Effect |
| --- | --- |
| `SessionStart` | Registers the session: `POST /sessions/register` with the session id, `project` (the cwd), `model`, and an agent name derived from the cwd's last path segment plus a short session-id suffix (e.g. `hmux-a1b2`). |
| `UserPromptSubmit` | Marks the session `working`, then checks the session's `bound` flag (`GET /sessions/:id`). If the human has bound the session from the TUI, it injects `additionalContext` telling the agent to use `mcp__hmux__ask` for questions/decisions and `mcp__hmux__notify` for progress — and to pass its roster `agent`/`project` on every call so inbox messages correlate with the roster entry. |
| `PostToolUse` | Heartbeat: marks the session `working` after every tool call, keeping actively-working agents fresh in the roster. Also picks up mid-task binds: when the session is bound and the context hasn't been injected into this conversation yet (tracked via a marker file in `~/.hmux/`), it injects the same bound context once. Unbinding clears the marker so a re-bind re-injects. |
| `PreToolUse` | For `mcp__hmux__*` calls only: stamps the harness-provided session id into the tool input, so message attribution is harness-asserted. Also the hmux listening post — `ask`/`approve` advertise a `message` label into the pane for the duration of the block, and `signal` stashes the declared turn-end status for `Stop` to promote. |
| `Stop` | Promotes a `signal` declared this turn into a hmux `message` label — `question` → "needs direction" (roster `needs-attention`), `done` → "done" — otherwise the session rests at `idle` with no label. |
| `Notification` | Marks the session `needs-attention` (permission prompts, idle prompts). The generic idle rewrite defers to a declared signal. |
| `SessionEnd` | Marks the session ended: `POST /sessions/:id/end`. |

Every status update bumps the session's `lastSeen`; staleness is computed by
consumers (the TUI), not the server.

Note on interrupts: no hook fires when the user interrupts Claude mid-turn
(the Stop hook explicitly excludes interrupts), so an interrupted session
reads `busy`/`working` until Claude Code's ~60s "waiting for your input"
notification fires — the Notification hook then corrects it to idle.

Note on idle sessions: Claude Code has no periodic hook, so a session sitting
idle at the prompt genuinely cannot heartbeat — its `lastSeen` freezes at the
last Stop. The TUI therefore keeps stale sessions listed (marked as "possibly
gone" with a hollow marker) rather than dropping them, only pruning sessions
silent for hours.

The plugin also declares the hmux MCP server ([`.mcp.json`](.mcp.json))
pointing at `http://localhost:7373/mcp`, so the `ask`/`notify`/`signal` tools
are available whenever the plugin is enabled. `signal` carries no content —
the agent calls it just before ending a turn (`status: "question" | "done"`)
to label how the turn ends; the response text in the chat is the content.

Heads-up: a bound session's FIRST `mcp__hmux__ask`/`mcp__hmux__notify`
call may hit a Claude Code permission prompt (which the TUI surfaces as a
blocked roster label). Allow the hmux tools once — e.g. "always allow" when
prompted — so bound agents can reach your inbox unattended.

## Headless agents: permission prompts in your inbox

Non-interactive (`-p`) runs have no terminal to show permission prompts.
The `hmux-run` wrapper ([`src/run.ts`](src/run.ts)) routes them to your
inbox — with a real roster identity:

```sh
bun run src/run.ts "run the release script" --agent release-bot
# or, with the package linked: hmux-run "run the release script"
```

It registers a session (agent from `--agent` or `<dirname>-<id>`, project =
cwd), writes a temp `--mcp-config` whose hmux server carries the identity
as headers (`x-hmux-agent`/`x-hmux-project`/`x-hmux-session`), then
runs

```sh
claude -p "task" --permission-prompt-tool mcp__hmux__approve --mcp-config <tmp>
```

streaming output through, and marks the session ended when claude exits.
Permissions are NOT skipped — each prompt appears in the mailbox's **approvals**
section and blocks the agent until you answer: accept the `allow` ghost
(tab, then ⏎) to approve; any other reply denies, with your text sent to the
agent as the reason. Multiple approvals can be shift-selected and allowed in
one go. The permission tool itself is exempt from permission checks.

Identity comes from registration (this wrapper, or the plugin's hooks for
interactive sessions): Claude Code invokes the permission tool itself with
only `tool_name`/`input`/`tool_use_id`, so the server resolves the caller
from the `/mcp` request headers instead — tool args, when present, still
win. Approvals with no resolvable identity are not blocked; they simply
display under a generated fallback name.
