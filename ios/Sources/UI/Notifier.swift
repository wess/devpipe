import UIKit
import UserNotifications

/// OSC 9/777/99, turned into something a person will actually see.
///
/// An agent that stops to ask permission is the single most common reason a
/// session sits idle, and the whole premise of leaving one running on a box is
/// that it can reach you. The emulator has always parsed the escape; nothing
/// was listening.
///
/// **What this can and cannot do.** It fires while the app is running,
/// including when the terminal that raised it is not the one on screen — which
/// is the case it is really for, since a tablet shows one pane at a time. It
/// cannot fire while the app is suspended: iOS closes the websocket, so there
/// is nothing to hear the escape with. Reaching a locked device needs the box
/// to tell the control plane and the control plane to send a push, which is
/// server work this does not pretend to do.
enum Notifier {
    private static var asked = false

    /// Asked for once, after sign-in, rather than on first launch at a person
    /// who has not yet seen what the app is for.
    static func requestPermission() {
        guard !asked else { return }
        asked = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
            granted, _ in
            trace("notifications: \(granted ? "granted" : "declined")")
        }
    }

    static func post(_ note: Term.Notification, session: String) {
        let content = UNMutableNotificationContent()
        content.title = note.title.isEmpty ? "Devpipe" : note.title
        content.body = note.body
        content.sound = .default
        content.userInfo = ["session": session]
        // Threaded by session, so an agent that asks twice does not push its
        // own first message off the screen.
        content.threadIdentifier = session

        UNUserNotificationCenter.current().add(
            UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

/// Shows a notification even while the app is in front, which is the only time
/// this app can raise one at all.
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationPresenter()

    /// Set by the shell so tapping a notification opens the terminal that
    /// raised it.
    var onOpenSession: ((String) -> Void)?

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let session = response.notification.request.content.userInfo["session"] as? String {
            DispatchQueue.main.async { [weak self] in self?.onOpenSession?(session) }
        }
        completionHandler()
    }
}
