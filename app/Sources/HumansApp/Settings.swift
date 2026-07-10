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

    // Command run when the user clicks a notification or "Open TUI". Prefilled
    // with defaultOpenTuiCommand once the repo path is known; always visible
    // and editable in Settings › Advanced.
    @AppStorage("openTuiCommand") var openTuiCommand: String = ""

    // Open-or-focus: the script focuses a running TUI's terminal window (via
    // @humans/focus) or launches one in a new window if none is alive. The
    // terminal-specific logic lives in JS, shared with the mux work.
    var defaultOpenTuiCommand: String {
        "bun \(repoPath)/packages/tui/src/open.ts"
    }

    // What defaultOpenTuiCommand produced before open.ts existed, so prefill
    // can recognize an untouched setting and migrate it. A user-edited
    // command won't match and is left alone.
    var legacyOpenTuiCommands: [String] {
        let run = "cd \(repoPath)/packages/tui && exec bun run src/index.tsx"
        return [
            "osascript -e 'tell application \"iTerm\" to activate' "
                + "-e 'tell application \"iTerm\" to tell current session of "
                + "(create window with default profile) to write text \"\(run)\"'",
            "osascript -e 'tell application \"Terminal\" to activate' "
                + "-e 'tell application \"Terminal\" to do script \"\(run)\"'"
        ]
    }

    var mcpEndpoint: String { "http://localhost:\(port)\(mcpPath)" }
    var wsURL: URL { URL(string: "ws://localhost:\(port)\(wsPath)")! }
    var mcpRegisterCommand: String {
        "claude mcp add --transport http humans \(mcpEndpoint)"
    }
}
