import SwiftUI

// The daily surface. Server status, start/stop, open TUI, a glance at active
// sessions, mute toggle, and the escape hatches to Settings / Quit.
struct MenuBarView: View {
    @ObservedObject var state: AppState
    @ObservedObject var settings: AppSettings
    @Environment(\.openWindow) private var openWindow

    init(state: AppState) {
        self.state = state
        self.settings = state.settings
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusRow
            Divider()

            Button {
                state.openTui()
            } label: {
                Label("Open TUI", systemImage: "arrow.up.forward.app")
            }

            Button {
                state.toggleServer()
            } label: {
                Label(state.serverRunning ? "Stop server" : "Start server",
                      systemImage: state.serverRunning ? "stop.circle" : "play.circle")
            }

            Divider()

            sessionsSection

            Toggle(isOn: $settings.muted) {
                Label("Mute notifications", systemImage: settings.muted ? "bell.slash" : "bell")
            }
            .toggleStyle(.checkbox)

            Divider()

            Button("Preferences…") { openPrefs() }
                .keyboardShortcut(",", modifiers: .command)
            if !settings.hasOnboarded {
                Button("Set up humans.sh…") { openWindow(id: "onboarding") }
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q", modifiers: .command)
        }
        .padding(6)
        .frame(width: 260)
    }

    private var statusRow: some View {
        HStack {
            Circle()
                .fill(statusColor)
                .frame(width: 9, height: 9)
            Text(statusText)
            Spacer()
            Text(":\(settings.port)")
                .foregroundStyle(.secondary)
                .font(.system(.caption, design: .monospaced))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var sessionsSection: some View {
        Text("Active sessions")
            .font(.caption)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.horizontal, 6)
            .padding(.top, 2)

        if state.sessions.isEmpty {
            Text(state.connected ? "None yet" : "Server offline")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
        } else {
            ForEach(state.sessions) { session in
                HStack {
                    Text(session.agent)
                        .lineLimit(1)
                    Spacer()
                    Text(session.detail ?? session.status.label)
                        .font(.caption)
                        .foregroundStyle(session.status == .needsAttention ? Color.green : .secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
            }
        }
        Divider()
    }

    private var statusColor: Color {
        if state.serverRunning && state.connected { return .green }
        if state.serverRunning { return .yellow }
        return .secondary
    }

    private var statusText: String {
        if state.serverRunning && state.connected { return "Server running" }
        if state.serverRunning { return "Server starting…" }
        if state.connected { return "Server running (external)" }
        return "Server stopped"
    }

    private func openPrefs() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "settings")
    }
}
