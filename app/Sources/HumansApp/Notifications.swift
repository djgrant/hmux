import Foundation
import UserNotifications

// Posts native notifications — the whole reason the app exists. Unlike the
// terminal-bell path, these carry the agent name, the question body, and a tap
// action that runs the user's "open TUI" command to focus the session.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    var onOpenTui: (() -> Void)?

    func configure() {
        center.delegate = self
    }

    // Current authorization, mapped to a simple granted/denied/undetermined.
    func authorizationStatus(_ completion: @escaping @Sendable (UNAuthorizationStatus) -> Void) {
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async { completion(status) }
        }
    }

    func requestAuthorization(_ completion: @escaping @Sendable (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async { completion(granted) }
        }
    }

    func post(for message: Message, sound: Bool) {
        let content = UNMutableNotificationContent()
        content.title = message.agent
        if let project = message.project, !project.isEmpty {
            content.subtitle = project
        }
        content.body = message.body
        if sound { content.sound = .default }
        content.userInfo = ["messageId": message.id]

        let request = UNNotificationRequest(
            identifier: message.id,
            content: content,
            trigger: nil
        )
        center.add(request)
    }

    // Tapping a notification focuses the session by running the open-TUI command.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        onOpenTui?()
        completionHandler()
    }

    // Show banners even when the app is frontmost (e.g. Settings open).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
