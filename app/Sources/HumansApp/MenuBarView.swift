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
            Divider().padding(.vertical, 4)

            MenuRow(action: { state.openTui() }) {
                Label("Open TUI", systemImage: "arrow.up.forward.app")
            }

            MenuRow(action: { state.toggleServer() }) {
                Label(state.serverRunning ? "Stop server" : "Start server",
                      systemImage: state.serverRunning ? "stop.circle" : "play.circle")
            }

            Divider().padding(.vertical, 4)

            sessionsSection

            MenuRow(action: { settings.muted.toggle() }) {
                Label("Mute notifications", systemImage: settings.muted ? "bell.slash" : "bell")
                Spacer()
                if settings.muted {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            if !state.notificationsAuthorized {
                MenuRow(action: {
                    if state.notificationsDenied {
                        state.openNotificationSettings()
                    } else {
                        state.requestNotificationAuthorization()
                    }
                }) {
                    Label(state.notificationsDenied
                            ? "Notifications denied — open Settings"
                            : "Enable notifications…",
                          systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }

            Divider().padding(.vertical, 4)

            MenuRow(action: { openPrefs() }) {
                Text("Preferences…")
                Spacer()
                Text("⌘,").foregroundStyle(.tertiary)
            }
            .keyboardShortcut(",", modifiers: .command)

            if !settings.hasOnboarded {
                MenuRow(action: { openWindow(id: "onboarding") }) {
                    Text("Set up humans.sh…")
                }
            }

            MenuRow(action: { NSApplication.shared.terminate(nil) }) {
                Text("Quit")
                Spacer()
                Text("⌘Q").foregroundStyle(.tertiary)
            }
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
            // verbatim: interpolating an Int into Text goes through the locale
            // formatter and turns 7373 into "7,373".
            Text(verbatim: ":\(settings.port)")
                .foregroundStyle(.secondary)
                .font(.system(.caption, design: .monospaced))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var sessionsSection: some View {
        Text("Active sessions")
            .font(.caption)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.horizontal, 8)
            .padding(.top, 2)

        if state.sessions.isEmpty {
            Text(state.connected ? "None yet" : "Server offline")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 8)
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
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
            }
        }
        Divider().padding(.vertical, 4)
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

// Full-width menu-item-style row: plain content, hover highlight, consistent
// insets — what a window-style MenuBarExtra doesn't give Buttons for free.
private struct MenuRow<Content: View>: View {
    let action: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var hovering = false

    init(action: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.action = action
        self.content = content
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                content()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(hovering ? Color.primary.opacity(0.08) : Color.clear)
        )
        .onHover { hovering = $0 }
    }
}
