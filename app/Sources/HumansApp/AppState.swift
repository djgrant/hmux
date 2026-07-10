import Foundation
import SwiftUI
import AppKit
import UserNotifications

// The coordinator. Holds the settings, owns the server process, the WebSocket
// connection, and the notification manager, and exposes the observable state
// the three GUI surfaces render.
@MainActor
final class AppState: ObservableObject {
    let settings = AppSettings()
    private let server = ServerProcess()
    private let notifications = Notifications()
    private var connection: ServerConnection!

    @Published var serverRunning = false
    @Published var connected = false
    @Published var sessions: [Session] = []
    @Published var notificationsAuthorized = false
    @Published var notificationsDenied = false

    // The port the supervised server was actually started with, so a port
    // change in Settings can restart it in place.
    private var runningPort: Int?

    var needsAttentionCount: Int {
        sessions.filter { $0.status == .needsAttention }.count
    }

    init() {
        notifications.configure()
        notifications.onOpenTui = { [weak self] in
            Task { @MainActor in self?.openTui() }
        }

        connection = ServerConnection(url: settings.wsURL)
        connection.onConnected = { [weak self] in
            Task { @MainActor in self?.connected = true }
        }
        connection.onDisconnected = { [weak self] in
            Task { @MainActor in self?.connected = false }
        }
        connection.onSessions = { [weak self] sessions in
            Task { @MainActor in self?.sessions = sessions }
        }
        connection.onNewMessage = { [weak self] message in
            Task { @MainActor in self?.handleNewMessage(message) }
        }

        server.onStateChange = { [weak self] in
            Task { @MainActor in self?.serverRunning = self?.server.isRunning ?? false }
        }

        refreshNotificationAuth()
        connection.connect()
        // If the app was launched at login and setup is done, bring the server up.
        if settings.hasOnboarded && !settings.repoPath.isEmpty {
            startServer()
        }
    }

    // MARK: - Server lifecycle

    func startServer() {
        guard !settings.repoPath.isEmpty else { return }
        runningPort = settings.port
        server.start(repoPath: settings.repoPath, port: settings.port)
    }

    func stopServer() {
        runningPort = nil
        server.stop()
    }

    func toggleServer() {
        server.isRunning ? stopServer() : startServer()
    }

    // MARK: - Notifications

    private func handleNewMessage(_ message: Message) {
        guard !settings.muted else { return }
        if settings.onlyWhenTuiUnfocused && tuiIsFocused() { return }
        if settings.quietHours && inQuietHours() { return }
        let sound = settings.notificationSound
        // UNUserNotificationCenter drops posts silently when authorization was
        // never requested (e.g. the Grant step was skipped in onboarding), so
        // resolve authorization before posting rather than assuming it.
        notifications.authorizationStatus { [weak self] status in
            Task { @MainActor in
                guard let self else { return }
                switch status {
                case .notDetermined:
                    self.notifications.requestAuthorization { granted in
                        Task { @MainActor in
                            self.notificationsAuthorized = granted
                            self.notificationsDenied = !granted
                            if granted { self.notifications.post(for: message, sound: sound) }
                        }
                    }
                case .denied:
                    self.notificationsAuthorized = false
                    self.notificationsDenied = true
                default:
                    self.notificationsAuthorized = true
                    self.notificationsDenied = false
                    self.notifications.post(for: message, sound: sound)
                }
            }
        }
    }

    func refreshNotificationAuth() {
        notifications.authorizationStatus { [weak self] status in
            Task { @MainActor in
                self?.notificationsAuthorized = (status == .authorized || status == .provisional)
                self?.notificationsDenied = (status == .denied)
            }
        }
    }

    func requestNotificationAuthorization() {
        notifications.requestAuthorization { [weak self] _ in
            Task { @MainActor in self?.refreshNotificationAuth() }
        }
    }

    // Focus gating: the app can't see the TUI's focus directly (that gate lives
    // in the terminal). Approximate it — suppress only when a known terminal app
    // is frontmost. A future protocol addition can report real TUI focus.
    private func tuiIsFocused() -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
            return false
        }
        let terminals = [
            "com.googlecode.iterm2",
            "com.apple.Terminal",
            "com.mitchellh.ghostty",
            "net.kovidgoyal.kitty",
            "dev.warp.Warp-Stable"
        ]
        return terminals.contains(front)
    }

    private func inQuietHours() -> Bool {
        // Simple 22:00–08:00 window for v0.
        let hour = Calendar.current.component(.hour, from: Date())
        return hour >= 22 || hour < 8
    }

    // MARK: - Actions

    func openTui() {
        let custom = settings.openTuiCommand.trimmingCharacters(in: .whitespaces)
        if !custom.isEmpty {
            runShell(custom)
            return
        }
        launchTuiInTerminal()
    }

    // Default "Open TUI": actually run the TUI, in the user's terminal — an
    // empty terminal window is not the product. Prefers iTerm when installed.
    private func launchTuiInTerminal() {
        guard !settings.repoPath.isEmpty else {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"))
            return
        }
        let cmd = "cd \(settings.repoPath)/packages/tui && exec bun run src/index.tsx"
        let script: String
        if FileManager.default.fileExists(atPath: "/Applications/iTerm.app") {
            // `create window … command "…"` does not shell-parse its string, so
            // type the command into a fresh window's shell instead.
            script = """
            tell application "iTerm"
                activate
                set w to (create window with default profile)
                tell current session of w to write text \(appleScriptQuoted(cmd))
            end tell
            """
        } else {
            script = """
            tell application "Terminal"
                activate
                do script \(appleScriptQuoted(cmd))
            end tell
            """
        }
        var error: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&error)
        if let error {
            NSLog("humans.sh: open TUI failed: \(error)")
        }
    }

    // Quote a string for embedding in an AppleScript source literal.
    private func appleScriptQuoted(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    func copyMcpEndpoint() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(settings.mcpEndpoint, forType: .string)
    }

    func copyMcpRegisterCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(settings.mcpRegisterCommand, forType: .string)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        LaunchAtLogin.set(enabled)
        settings.launchAtLogin = LaunchAtLogin.isEnabled
    }

    func onSettingsChanged() {
        connection.updateURL(settings.wsURL)
        // A port change must move the supervised server too, or the status dot
        // goes yellow forever while the old server sits on the old port.
        if serverRunning, let current = runningPort, current != settings.port {
            stopServer()
            startServer()
        }
    }

    // Deep-link to the app's pane in System Settings › Notifications, for when
    // authorization was denied and only the user can flip it back on.
    func openNotificationSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
        NSWorkspace.shared.open(url)
    }

    func chooseRepoPath() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose humans.sh repo"
        if panel.runModal() == .OK, let url = panel.url {
            settings.repoPath = url.path
        }
    }

    private func runShell(_ command: String) {
        guard !command.isEmpty else { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = ["-lc", command]
        try? task.run()
    }
}
