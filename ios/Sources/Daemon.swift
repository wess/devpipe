import Foundation
import Network
import UIKit

struct DaemonConfig: Hashable {
    var host: String
    var port: Int
    var token: String
    /// SHA-256 of the daemon's certificate. Empty only in `--insecure` mode.
    var fingerprint: String
    /// Plain ws, for loopback development. Never a default.
    var insecure: Bool

    var scheme: String { insecure ? "http" : "https" }
    var wsScheme: String { insecure ? "ws" : "wss" }
    var httpBase: String { "\(scheme)://\(host):\(port)" }
    var wsBase: String { "\(wsScheme)://\(host):\(port)" }

    /// Overridable at launch so a simulator run can point at a daemon without
    /// rebuilding:
    ///   --host 10.0.0.5 --port 7788 --token abc --fingerprint 98f4...
    static func fromLaunchArgs() -> DaemonConfig {
        let args = ProcessInfo.processInfo.arguments
        func value(_ flag: String, _ fallback: String) -> String {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return fallback }
            return args[i + 1]
        }
        return DaemonConfig(
            host: value("--host", "127.0.0.1"),
            port: Int(value("--port", "7788")) ?? 7788,
            token: value("--token", "devpipe"),
            fingerprint: value("--fingerprint", ""),
            insecure: args.contains("--insecure")
        )
    }
}

struct SessionInfo: Codable, Identifiable, Equatable {
    let id: String
    let argv: [String]
    let cols: Int
    let rows: Int
    let title: String
    let alive: Bool

    /// What the session list shows. The child's own title wins when it sets
    /// one, which is how a running agent labels its own pane.
    var label: String {
        if !title.isEmpty { return title }
        return argv.first.map { URL(fileURLWithPath: $0).lastPathComponent } ?? id
    }
}

enum DaemonError: Error, LocalizedError {
    case http(Int, String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .http(let code, let body): return "daemon returned \(code): \(body)"
        case .badResponse: return "unreadable response from daemon"
        }
    }
}

struct Daemon {
    let config: DaemonConfig

    /// Its own session, not `URLSession.shared`: the shared one cannot carry a
    /// delegate, and the delegate is what does the pinning.
    private var session: URLSession { URLSessionFactory.make(for: config) }

    private func request(_ method: String, _ path: String, body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: URL(string: config.httpBase + path)!)
        req.httpMethod = method
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest, as: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw DaemonError.http(http.statusCode, String(decoding: data, as: UTF8.self))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func sessions() async throws -> [SessionInfo] {
        try await send(request("GET", "/v1/sessions"), as: [SessionInfo].self)
    }

    func create(argv: [String], cols: Int, rows: Int) async throws -> SessionInfo {
        let body = try JSONEncoder().encode(
            ["argv": .array(argv.map { .string($0) }),
             "cols": .number(Double(cols)),
             "rows": .number(Double(rows))] as [String: JSONValue])
        return try await send(request("POST", "/v1/sessions", body: body), as: SessionInfo.self)
    }

    func kill(_ id: String) async throws {
        _ = try await session.data(for: request("DELETE", "/v1/sessions/\(id)"))
    }
}

/// Builds URLSessions that pin, and keeps the delegate alive for as long as
/// the session it belongs to. A delegate that gets deallocated takes the
/// pinning with it and the connection quietly falls back to system trust.
enum URLSessionFactory {
    private static var cache: [DaemonConfig: URLSession] = [:]
    private static let lock = NSLock()

    static func make(for config: DaemonConfig) -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let existing = cache[config] { return existing }
        let session: URLSession
        if config.insecure {
            session = URLSession(configuration: .default)
        } else {
            session = URLSession(
                configuration: .default,
                delegate: PinnedTrust(fingerprint: config.fingerprint),
                delegateQueue: nil)
        }
        cache[config] = session
        return session
    }
}

/// Just enough JSON to build one request body without a model type per shape.
enum JSONValue: Encodable {
    case string(String)
    case number(Double)
    case array([JSONValue])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .array(let a): try c.encode(a)
        }
    }
}

/// Attaches to one session. Binary frames are pty bytes; text frames are
/// control JSON — the same split the daemon uses, so neither side has to
/// frame or escape anything.
///
/// It also reconnects, which on iOS is not a nicety. The system suspends a
/// backgrounded app and the socket dies with it, so *every* trip to another
/// app ends the connection. Without reconnection the persistence the daemon
/// provides is invisible: the session really is still running, but the only
/// way to see it again is to force-quit and relaunch.
final class WebSocketSource: NSObject, ByteSource, URLSessionWebSocketDelegate {
    var onBytes: ((Data) -> Void)?
    var onState: ((String) -> Void)?

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
    private let monitor = NWPathMonitor()

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

        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, path.status == .satisfied else { return }
            reconnectNow(because: "network came back")
        }
        monitor.start(queue: DispatchQueue(label: "io.wess.devpipe.path"))
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        monitor.cancel()
    }

    func start() {
        finished = false
        attempt = 0
        connect()
    }

    func stop() {
        finished = true
        retry?.cancel()
        retry = nil
        monitor.cancel()
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func connect() {
        guard !finished else { return }
        retry?.cancel()
        retry = nil
        generation += 1
        let mine = generation

        var req = URLRequest(
            url: URL(string: "\(config.wsBase)/v1/sessions/\(sessionId)/attach")!)
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: req)
        self.task = task
        task.resume()
        receive(generation: mine)
    }

    @objc private func cameBack() {
        reconnectNow(because: "back in the foreground")
    }

    private func reconnectNow(because reason: String) {
        guard !finished, task?.state != .running else { return }
        attempt = 0
        onState?("reconnecting — \(reason)")
        DispatchQueue.main.async { [weak self] in self?.connect() }
    }

    /// Something ended the socket. Reconnect unless we ended it ourselves.
    private func dropped(_ why: String, generation gen: Int) {
        guard !finished, gen == generation else { return }
        onState?(why)
        scheduleRetry()
    }

    private func scheduleRetry() {
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
        onState?("reconnecting in \(String(format: "%.0f", delay))s")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Keystrokes are never logged. Tracing this path was what found the
    /// Ctrl+C bug, but everything typed into a terminal goes through here —
    /// passwords, tokens, keys — and a debug line would put all of it in the
    /// system log. Trace on the daemon side instead, behind
    /// `DEVPIPE_TRACE_INPUT`, where it is opt-in and stays on one machine.
    func send(_ data: Data) {
        guard !data.isEmpty else { return }
        task?.send(.data(data)) { [weak self] error in
            if error != nil { self?.onState?("not connected") }
        }
    }

    func resize(cols: Int, rows: Int) {
        // Remembered rather than only sent: a reconnect has to re-assert the
        // size, or the pty keeps whatever it was created with.
        pendingSize = (cols, rows)
        let msg = #"{"t":"resize","cols":\#(cols),"rows":\#(rows)}"#
        task?.send(.string(msg)) { _ in }
    }

    private func receive(generation gen: Int) {
        task?.receive { [weak self] result in
            guard let self, !finished, gen == generation else { return }
            switch result {
            case .failure:
                // The message is deliberately plain. "Socket closed with
                // error -1005" tells the user nothing they can act on.
                dropped("connection lost", generation: gen)
            case .success(let message):
                switch message {
                case .data(let d): onBytes?(d)
                case .string(let s): handleControl(s)
                @unknown default: break
                }
                receive(generation: gen)
            }
        }
    }

    private func handleControl(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = obj["t"] as? String
        else { return }
        switch kind {
        case "hello":
            attempt = 0
            onState?("attached to \(obj["id"] as? String ?? sessionId)")
            // The daemon's size is authoritative only until the client has
            // laid out; re-assert whatever the view actually measured. On a
            // reconnect this is what puts the pty back to the right size.
            if let size = pendingSize { resize(cols: size.cols, rows: size.rows) }
        case "resync":
            onState?("caught up")
        case "exit":
            // The child is gone, so retrying would attach to nothing.
            finished = true
            onState?("session ended")
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
        onState?("connected")
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        dropped("disconnected", generation: generation)
    }
}
