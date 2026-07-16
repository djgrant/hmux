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

`--status` is one word (`message`, `busy`, `error`, `idle`); `--detail` is optional one-line context. `--agent`, `--resume` and `--transcript` describe the pane's occupant: its identity, the command that brings it back after a restore, and the path to its conversation transcript (read by the control MCP below, never by the picker).

Claude Code advertises automatically via [hmux-cc-plugin](../cc-plugin). See the [repo README](../..) for the wider picture.

## MCP

hmux exposes two MCP servers with distinct jobs.

### hmux-signals (HTTP)

For agents running **inside** hmux sessions: ask you a question, request approval, send a notification. You never start it — every hmux entrypoint spawns it if nothing answers on the port (default `:7373`, override with `HMUX_URL`; logs in `~/.hmux/server.log`). Register it in your agents' MCP config:

```json
{ "hmux-signals": { "type": "http", "url": "http://localhost:7373/mcp" } }
```

### hmux-control (stdio)

For **one** overseer agent — a chief of staff that reads each session's conversation and dispatches your decisions into them. The MCP client spawns it per session; there is nothing to daemonise. Register it only in the overseer's config — worker agents have no business reading other sessions or typing into their prompts:

```json
{ "hmux-control": { "command": "hmux", "args": ["mcp"] } }
```

Five tools:

- `list` — the map: sessions, windows, agents, advertised status, transcript availability.
- `read` — an agent's recent conversation, from its advertised transcript (tool results elided by default). hmux never inspects the pane itself, so a pane with no advertised transcript is opaque. Sessions advertised before `--transcript` existed fall back to the resume command's session id.
- `send` — paste a message into the agent's prompt and submit it, exactly as if you had typed it there.

  Both address a **pane** — that's where an agent lives. Any target from `list` works: a pane id (`%7`) means exactly that pane; a window (`api:1`) means its sole agent pane, and is refused with the candidates named when the window holds several agents; a bare session means its first window. The reply lands in that session; `read` picks it up. A sender that needs the reply can arm `hmux wait <target>` in a background shell: it blocks until the agent settles (status leaves `busy` — via a busy→settled transition, or a grace period when no busy is ever seen, so arming just after a send doesn't return early), prints the final status, and exits (`--timeout <seconds>` exits 3 on expiry).
- `open` — load a session into your parked display target (`hmux target`), for when you want eyes on it yourself.
- `create` — new session or `session/window`; dispatching new work is a `create` followed by a `send`.

There is deliberately no `kill` and no advertise write path: the surface briefs and dispatches, it does not reap, and it cannot forge another agent's advertised state.
