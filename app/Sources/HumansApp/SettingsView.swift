import SwiftUI

// Seen occasionally. Port, launch-at-login, notification behaviour, focus
// gating — all forms and toggles, nothing that touches the message workflow.
struct SettingsView: View {
    @ObservedObject var state: AppState
    @ObservedObject var settings: AppSettings

    init(state: AppState) {
        self.state = state
        self.settings = state.settings
    }

    var body: some View {
        TabView {
            general.tabItem { Label("General", systemImage: "gear") }
            notifications.tabItem { Label("Notifications", systemImage: "bell") }
            advanced.tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
        }
        .frame(width: 420)
        .padding(20)
    }

    private var general: some View {
        Form {
            LabeledContent("Server port") {
                TextField("", value: $settings.port, format: .number.grouping(.never))
                    .frame(width: 80)
                    .onSubmit { state.onSettingsChanged() }
            }
            Toggle("Launch at login", isOn: Binding(
                get: { settings.launchAtLogin },
                set: { state.setLaunchAtLogin($0) }
            ))
            LabeledContent("humans.sh repo") {
                HStack {
                    Text(settings.repoPath.isEmpty ? "Not set" : settings.repoPath)
                        .foregroundStyle(settings.repoPath.isEmpty ? .secondary : .primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Button("Choose…") { state.chooseRepoPath() }
                }
            }
        }
        .formStyle(.grouped)
    }

    private var notifications: some View {
        Form {
            Toggle("Notification sound", isOn: $settings.notificationSound)
            Toggle("Only when TUI unfocused", isOn: $settings.onlyWhenTuiUnfocused)
            Toggle("Quiet hours (22:00–08:00)", isOn: $settings.quietHours)
            Toggle("Mute all notifications", isOn: $settings.muted)
        }
        .formStyle(.grouped)
    }

    private var advanced: some View {
        Form {
            LabeledContent("MCP endpoint") {
                HStack {
                    Text(settings.mcpEndpoint)
                        .font(.system(.caption, design: .monospaced))
                    Button {
                        state.copyMcpEndpoint()
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                }
            }
            Section {
                LabeledContent("Open-TUI command") {
                    TextField("auto", text: $settings.openTuiCommand)
                }
            } footer: {
                Text("Runs when you click a notification or “Open TUI”. Leave empty for the default: launch the TUI from the repo in \(FileManager.default.fileExists(atPath: "/Applications/iTerm.app") ? "iTerm" : "Terminal"). Custom commands run via zsh -lc, so your PATH and aliases apply.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button("Re-register plugin & MCP") {
                state.copyMcpRegisterCommand()
            }
        }
        .formStyle(.grouped)
    }
}
