import SwiftUI

// Seen once. The setup checklist: point at the repo, grant notifications,
// install the Claude Code plugin, register the MCP endpoint, confirm the
// server is up. This is where the macOS permission story is won or lost, so
// each step shows its live state.
struct OnboardingView: View {
    @ObservedObject var state: AppState
    @ObservedObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    init(state: AppState) {
        self.state = state
        self.settings = state.settings
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Set up humans.sh").font(.headline)
                Text("A few things and you're live.").foregroundStyle(.secondary).font(.subheadline)
            }
            .padding(.bottom, 12)

            step(icon: "folder", title: "humans.sh repo",
                 detail: settings.repoPath.isEmpty ? nil : settings.repoPath,
                 done: !settings.repoPath.isEmpty) {
                Button("Choose…") { state.chooseRepoPath() }
            }

            step(icon: "bell", title: "Notifications",
                 done: state.notificationsAuthorized) {
                Button("Grant") { state.requestNotificationAuthorization() }
                    .disabled(state.notificationsAuthorized)
            }

            step(icon: "puzzlepiece.extension", title: "Claude Code plugin",
                 detail: "claude --plugin-dir …/packages/cc-plugin",
                 done: false) {
                Button("Copy") {
                    let cmd = settings.repoPath.isEmpty
                        ? "claude --plugin-dir <repo>/packages/cc-plugin"
                        : "claude --plugin-dir \(settings.repoPath)/packages/cc-plugin"
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(cmd, forType: .string)
                }
            }

            step(icon: "terminal", title: "MCP endpoint",
                 detail: settings.mcpEndpoint,
                 done: false) {
                Button {
                    state.copyMcpRegisterCommand()
                } label: {
                    Label("copy", systemImage: "doc.on.doc")
                }
            }

            step(icon: "server.rack", title: "Server started",
                 done: state.serverRunning) {
                if !state.serverRunning {
                    Button("Start") { state.startServer() }
                        .disabled(settings.repoPath.isEmpty)
                }
            }

            Divider().padding(.vertical, 8)

            HStack {
                Spacer()
                Button("Continue") {
                    settings.hasOnboarded = true
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear { state.refreshNotificationAuth() }
    }

    @ViewBuilder
    private func step<Trailing: View>(
        icon: String,
        title: String,
        detail: String? = nil,
        done: Bool,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: icon)
                .frame(width: 18)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                if let detail {
                    Text(detail)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer()
            if done {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                trailing()
            }
        }
        .padding(.vertical, 6)
    }
}
