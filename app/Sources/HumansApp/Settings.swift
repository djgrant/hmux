import Foundation
import SwiftUI

// User-facing preferences, persisted to UserDefaults. These map 1:1 to the
// Settings window in the mockups.
final class AppSettings: ObservableObject {
    private let defaults = UserDefaults.standard

    @AppStorage("port") var port: Int = defaultPort
    @AppStorage("launchAtLogin") var launchAtLogin: Bool = false
    @AppStorage("notificationSound") var notificationSound: Bool = true
    @AppStorage("onlyWhenTuiUnfocused") var onlyWhenTuiUnfocused: Bool = true
    @AppStorage("quietHours") var quietHours: Bool = false
    @AppStorage("muted") var muted: Bool = false
    @AppStorage("hasOnboarded") var hasOnboarded: Bool = false

    // Path to the humans.sh repo, so the app can launch the bundled bun server
    // and the TUI. Chosen once during onboarding.
    @AppStorage("repoPath") var repoPath: String = ""

    // Command run when the user clicks a notification or "Open TUI". Empty
    // means auto: launch the TUI from the repo in iTerm (or Terminal).
    @AppStorage("openTuiCommand") var openTuiCommand: String = ""

    var mcpEndpoint: String { "http://localhost:\(port)\(mcpPath)" }
    var wsURL: URL { URL(string: "ws://localhost:\(port)\(wsPath)")! }
    var mcpRegisterCommand: String {
        "claude mcp add --transport http humans \(mcpEndpoint)"
    }
}
