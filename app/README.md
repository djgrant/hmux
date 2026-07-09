# humans.sh — native Mac app

The small menu-bar app that sits underneath the TUI. See
[../design/product-brief.md](../design/product-brief.md) for the why.

The TUI stays the product — where you read messages and answer agents. This
app owns only what a TUI can't own from inside a terminal pane:

1. **Notifications** — posted natively, carrying agent, question, and a tap
   action that focuses the session. No escape sequences, no tmux corruption.
2. **The server** — the app spawns and supervises the humans.sh server, so it
   stays up whether or not a terminal is open, under one signed identity.
3. **Identity & setup** — one app to authorise once, plus the first-run flow
   that wires up the Claude Code plugin and the MCP endpoint.

## The three surfaces

- **Menu-bar dropdown** (daily) — server status, start/stop, open TUI, active
  sessions, mute. `MenuBarView.swift`
- **Onboarding** (first-run) — repo path, notifications, plugin, MCP endpoint,
  server. `OnboardingView.swift`
- **Settings** (occasional) — port, launch-at-login, notification behaviour,
  focus gating. `SettingsView.swift`

## Build & run

```sh
./build.sh            # → build/humans.sh.app  (ad-hoc signed)
open build/humans.sh.app
```

For a distributable build, code-sign with a Developer ID:

```sh
SIGN_IDENTITY="Developer ID Application: …" ./build.sh
cp -R build/humans.sh.app /Applications/
```

For a full notarized release in one command (sign → notarize → staple →
Gatekeeper-verify), add `--notarize`:

```sh
SIGN_IDENTITY="Developer ID Application: …" ./build.sh --notarize
```

It needs a stored notarytool credential profile (`NOTARY_PROFILE`, default
`humans.sh`). Create it once:

```sh
xcrun notarytool store-credentials humans.sh \
  --apple-id <you> --team-id <TEAMID> --password <app-specific-password>
```

The stapled ticket is embedded in the bundle, so the app verifies even offline
and runs cleanly on any Mac.

It's a SwiftPM executable wrapped into a `.app` bundle (`LSUIElement`, bundle
id `sh.humans.app`) by `build.sh` — no Xcode project. Requires macOS 13+
(`SMAppService`, `MenuBarExtra`).

## How it fits together

- `Protocol.swift` — Codable mirror of `@humans/protocol` (read-only subset).
- `ServerConnection.swift` — read-only WebSocket client for presence + inbound
  messages; never sends frames (answering stays in the TUI).
- `ServerProcess.swift` — supervises `bun packages/server/src/index.ts`.
- `Notifications.swift` — `UNUserNotificationCenter`, tap → open-TUI command.
- `LaunchAtLogin.swift` — `SMAppService.mainApp`.
- `AppState.swift` — the coordinator the three views observe.

## Known limits (v0)

- **Focus gating** approximates the TUI's real focus by checking whether a
  known terminal app is frontmost. The proper fix is the TUI reporting focus
  over the WebSocket (a protocol addition) — see the brief's open questions.
- The server runs as a supervised child (restart-on-crash with backoff), by
  design — not a launchd agent. See the brief's Decisions section for why.
- Locality: notifications assume the server is on the same Mac (localhost).
