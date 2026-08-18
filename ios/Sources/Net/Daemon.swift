import Foundation
import Network
import UIKit

struct DaemonConfig: Hashable {
    var host: String
    var port: Int
    var token: String
    /// SHA-256 of the daemon's certificate. Empty when the box has a real
    /// name and a CA-issued certificate, which is now every box.
    var fingerprint: String
    /// Plain ws, for loopback development. Never a default.
    var insecure: Bool

    var scheme: String { insecure ? "http" : "https" }
    var wsScheme: String { insecure ? "ws" : "wss" }
    var httpBase: String { "\(scheme)://\(host):\(port)" }
    var wsBase: String { "\(wsScheme)://\(host):\(port)" }

    /// Overridable at launch so a simulator run can point at a daemon on this
    /// machine without a control plane in the middle:
    ///   --host 10.0.0.5 --port 7788 --token abc --insecure
    static func fromLaunchArgs() -> DaemonConfig? {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--host") else { return nil }
        func value(_ flag: String, _ fallback: String) -> String {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return fallback }
            return args[i + 1]
        }
        return DaemonConfig(
            host: value("--host", "127.0.0.1"),
            port: Int(value("--port", "7788")) ?? 7788,
            token: value("--token", "devpipe"),
            fingerprint: value("--fingerprint", ""),
            insecure: args.contains("--insecure"))
    }
}

/// Attaches to one session.
///
/// Binary frames are pty bytes; text frames are control JSON — the same split
/// the daemon uses, so neither side has to frame or escape anything.
///
/// It also reconnects, which on iOS is not a nicety. The system suspends a
/// backgrounded app and the socket dies with it, so *every* trip to another app
/// ends the connection. Without reconnection the persistence the daemon
/// provides is invisible: the session really is still running, but the only way
/// to see it again would be to force-quit and relaunch.
final class WebSocketSource: NSObject, ByteSource, URLSessionWebSocketDelegate {
    var onBytes: ((Data) -> Void)?
    var onState: ((TransportState) -> Void)?

    private let config: DaemonConfig
    private let sessionId: String
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var pendingSize: (cols: Int, rows: Int)?

    /// Set by `stop()`. Distinguishes "the user switched sessions" from "the
    /// network went away", because only one of those should reconnect.
    private var finished = false

    /// Callbacks from a socket we have already replaced would otherwise queue
    /// a second reconnect and race the first.
    private var generation = 0
    private var attempt = 0
    private var retry: DispatchWorkItem?
    private var monitor: NWPathMonitor?
    private var keepalive: Timer?

    /// Holds the pinning delegate for the lifetime of the socket. URLSession
    /// keeps only a weak reference to its delegate through us, so letting this
    /// go would drop pinning mid-connection.
    private let pinning: PinnedTrust?

    init(config: DaemonConfig, sessionId: String) {
        self.config = config
        self.sessionId = sessionId
        self.pinning = config.insecure ? nil : PinnedTrust(fingerprint: config.fingerprint)
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

        // Coming back to the app is the single most common way a connection
        // needs re-establishing, and it is worth reacting to directly rather
        // than waiting for a backoff timer that did not run while suspended.
        NotificationCenter.default.addObserver(
            self, selector: #selector(cameBack),
            name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        monitor?.cancel()
        keepalive?.invalidate()
    }

    func start() {
        finished = false
        attempt = 0
        watchNetwork()
        connect()
    }

    func stop() {
        finished = true
        retry?.cancel()
        retry = nil
        monitor?.cancel()
        monitor = nil
        keepalive?.invalidate()
        keepalive = nil
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onState?(.idle)
    }

    /// Restarted on every `start`, because `stop` cancels it and a cancelled
    /// `NWPathMonitor` never reports again — a source that was stopped and
    /// started would have been left with no idea the network came back.
    private func watchNetwork() {
        monitor?.cancel()
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, path.status == .satisfied else { return }
            reconnectNow(because: "network came back")
        }
        monitor.start(queue: DispatchQueue(label: "io.wess.devpipe.path"))
        self.monitor = monitor
    }

    private func connect() {
        guard !finished else { return }
        retry?.cancel()
        retry = nil
        generation += 1
        let mine = generation

        onState?(.connecting)
        var request = URLRequest(
            url: URL(string: "\(config.wsBase)/v1/sessions/\(sessionId)/attach")!)
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        receive(generation: mine)
        startKeepalive()
    }

    /// A websocket that dies to a NAT timeout or a dropped cellular bearer
    /// does not close — it simply stops delivering, and `receive` waits
    /// forever. A ping every twenty seconds turns that into a failure the
    /// reconnect logic can act on.
    private func startKeepalive() {
        keepalive?.invalidate()
        keepalive = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            guard let self, let task, !finished else { return }
            let mine = generation
            task.sendPing { [weak self] error in
                guard let self, error != nil else { return }
                DispatchQueue.main.async { [weak self] in
                    self?.dropped("connection lost", generation: mine)
                }
            }
        }
    }

    @objc private func cameBack() {
        reconnectNow(because: "back in the foreground")
    }

    private func reconnectNow(because reason: String) {
        guard !finished, task?.state != .running else { return }
        attempt = 0
        onState?(.waiting(seconds: 0, reason: reason))
        DispatchQueue.main.async { [weak self] in self?.connect() }
    }

    /// Something ended the socket. Reconnect unless we ended it ourselves.
    private func dropped(_ why: String, generation gen: Int) {
        guard !finished, gen == generation else { return }
        keepalive?.invalidate()
        keepalive = nil
        scheduleRetry(why)
    }

    private func scheduleRetry(_ why: String) {
        guard !finished, retry == nil else { return }
        attempt += 1
        // Backs off to fifteen seconds and stays there. Jitter keeps a daemon
        // restart from being met by every client retrying in lockstep.
        let base = min(pow(2.0, Double(attempt - 1)) * 0.5, 15.0)
        let delay = base + Double.random(in: 0...0.4)

        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            retry = nil
            connect()
        }
        retry = work
        onState?(.waiting(seconds: Int(delay.rounded()), reason: why))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Keystrokes are never logged. Tracing this path was what found the
    /// Ctrl+C bug, but everything typed into a terminal goes through here —
    /// passwords, tokens, keys — and a debug line would put all of it in the
    /// system log. Trace on the daemon side instead, behind
    /// `DEVPIPE_TRACE_INPUT`, where it is opt-in and stays on one machine.
    func send(_ data: Data) {
        guard !data.isEmpty else { return }
        let mine = generation
        task?.send(.data(data)) { [weak self] error in
            guard error != nil else { return }
            DispatchQueue.main.async { [weak self] in
                self?.dropped("connection lost", generation: mine)
            }
        }
    }

    func resize(cols: Int, rows: Int) {
        // Remembered rather than only sent: a reconnect has to re-assert the
        // size, or the pty keeps whatever it was created with.
        pendingSize = (cols, rows)
        let message = #"{"t":"resize","cols":\#(cols),"rows":\#(rows)}"#
        task?.send(.string(message)) { _ in }
    }

    private func receive(generation gen: Int) {
        task?.receive { [weak self] result in
            guard let self, !finished, gen == generation else { return }
            switch result {
            case .failure:
                dropped("connection lost", generation: gen)
            case .success(let message):
                switch message {
                case .data(let data): onBytes?(data)
                case .string(let text): handleControl(text)
                @unknown default: break
                }
                receive(generation: gen)
            }
        }
    }

    private func handleControl(_ text: String) {
        guard let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let kind = object["t"] as? String
        else { return }
        switch kind {
        case "hello":
            attempt = 0
            onState?(.attached(object["id"] as? String ?? sessionId))
            // The daemon's size is authoritative only until the client has laid
            // out; re-assert whatever the view actually measured. On a
            // reconnect this is what puts the pty back to the right size.
            if let size = pendingSize { resize(cols: size.cols, rows: size.rows) }
        case "resync":
            onState?(.resynced)
        case "exit":
            // The child is gone, so retrying would attach to nothing.
            finished = true
            keepalive?.invalidate()
            keepalive = nil
            onState?(.ended("session ended"))
        default:
            break
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let pinning else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        pinning.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        attempt = 0
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        dropped("disconnected", generation: generation)
    }
}
