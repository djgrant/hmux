import SwiftUI

@main
struct HumansApp: App {
    @StateObject private var state = AppState()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(state: state)
        } label: {
            // A message glyph, badged when a session needs the human.
            let needs = state.needsAttentionCount
            Image(systemName: needs > 0 ? "message.badge.fill" : "message")
        }
        .menuBarExtraStyle(.window)

        Window("Welcome", id: "onboarding") {
            OnboardingView(state: state)
        }
        .windowResizability(.contentSize)

        Window("Settings", id: "settings") {
            SettingsView(state: state)
        }
        .windowResizability(.contentSize)
    }
}
