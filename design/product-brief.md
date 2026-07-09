# humans.sh — native app product brief

The product is the TUI. This brief is about the small Mac app that sits underneath it, and why it needs to exist at all.

## The problem it solves

humans.sh notifies you when an agent needs a human. Today that notification is a terminal bell – a single `\x07` byte the TUI writes to stdout, which iTerm turns into a system notification.

The bell is a fallback, not a choice. The richer path – an OSC escape sequence carrying a title and body – gets mangled when the TUI runs inside tmux under iTerm's control mode: tmux forwards the wrapped sequence verbatim and iTerm prints the payload as literal text over the UI. So we fell back to the bell, and the bell carries no information. You get a ding, but not who from or what about.

Every attempt to fix this from inside the terminal runs into the same wall: the notification has to travel through the terminal, and the terminal is the thing corrupting it. The fix is to stop going through the terminal.

## What the app is for

The app is the piece that lives outside the terminal. It exists to own the three things a TUI can't own well from inside a pane:

1. **Notifications.** The app posts them natively, so they carry a title, a body, and a click action that focuses the right session. No escape sequences, no tmux passthrough, no corruption.
2. **A persistent server.** The humans.sh server needs to be up whether or not a terminal is open. The app registers it as a launch agent (via `SMAppService`), so macOS keeps it running and attributes its permissions to a single, signed identity rather than to whatever process happened to spawn it.
3. **Identity and setup.** One app the user authorises once – for notifications, for launch-at-login – instead of a scatter of per-helper permission prompts. It also carries the first-run flow that wires up the Claude Code plugin and the MCP endpoint.

Put another way: the notification problem and the distribution problem want the same artefact – a signed Mac app that owns identity, background persistence, and notifications. Solving one buys the other.

## What the app is not

It is not where you read messages or answer agents. That is the TUI's job, and the TUI stays the product. The app ships no message list, no session detail, no dashboard – anything that touches the message workflow belongs in the terminal.

The litmus test: if it's about the message or session workflow, it goes in the TUI; if it's about the app's own lifecycle, identity, or setup, it goes in the app.

## The GUI surfaces

Applying that test, the app's entire GUI comes to three surfaces. Mockups are in [gui-mockups.html](./gui-mockups.html).

- **Menu-bar dropdown** – the only surface seen daily. Server status, start/stop, "open TUI", a glance at active sessions, mute toggle.
- **Onboarding window** – seen once. The setup checklist: grant notifications, install the plugin, register the MCP endpoint, confirm the server started. This is the highest-leverage screen, because it's where the macOS permission story is won or lost.
- **Settings window** – seen occasionally. Port, launch-at-login, notification behaviour, focus gating.

All three are forms and status. None of them competes with the TUI.

## Decisions (settled)

The build resolved every open question. These are closed — don't reopen them without a new forcing reason (noted per item).

- **Standalone app, not a SwiftBar host.** It's its own `humans.sh.app` (bundle id `sh.humans.app`), because notifications and `SMAppService` both need a stable, signed bundle identity of its own — a SwiftBar plugin has none. *Reopen only if* the notification/identity requirements go away.
- **Server runs as a supervised child of the app, not a launchd agent.** The app is already mandatory (notifications come from it), so its lifetime bounds the server's — a launchd agent that outlived the notifier would buy nothing. The one thing launchd offered for free, restart-on-crash, is implemented in `ServerProcess` (exponential backoff, healthy-uptime reset). *Reopen only if* we need a headless server on a box with no logged-in GUI — which contradicts the locality decision below.
- **Locality: localhost, same Mac.** Notifications assume the server is on the human's machine. This is an accepted constraint, not a gap. *Reopen only if* a remote/hosted server lands (the Elixir backend), at which point notification delivery needs rethinking anyway.
- **Focus gating: frontmost-terminal heuristic now, TUI-reported focus later.** v0 suppresses notifications when a known terminal app is frontmost. The precise gate — the TUI reporting focus over the WebSocket — is a deferred protocol addition, tracked but not blocking.
- **`SMAppService` / macOS 13+ is the floor.** Accepted. Dropping older macOS is fine.
