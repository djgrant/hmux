import Foundation
import ServiceManagement

// Launch-at-login via SMAppService (macOS 13+). Registers the app itself as a
// login item; the app in turn owns the server process. Failures are surfaced
// but never fatal — the toggle just reflects the real registration state.
enum LaunchAtLogin {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func set(_ enabled: Bool) {
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            } else {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                }
            }
        } catch {
            NSLog("humans.sh: launch-at-login toggle failed: \(error.localizedDescription)")
        }
    }
}
