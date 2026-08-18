import Foundation
import SwiftUI

/// Attaching straight to a daemon, with no control plane in the middle.
///
/// This is how the terminal gets exercised end to end during development: run
/// `devpiped` on this machine and launch with
/// `--host 127.0.0.1 --port 7788 --token devpipe --insecure`. A real pty, a
/// real shell, a real socket — everything the product does except the account.
enum LocalDaemon {
    /// The first session on the daemon, making one if there is none.
    static func attachableSession(_ config: DaemonConfig) async -> String? {
        func request(_ method: String, _ path: String, body: Data? = nil) -> URLRequest {
            var request = URLRequest(url: URL(string: config.httpBase + path)!)
            request.httpMethod = method
            request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = body
            }
            return request
        }

        struct Session: Decodable { let id: String }
        let session = URLSessionFactory.make(for: config)

        if let (data, _) = try? await session.data(for: request("GET", "/v1/sessions")),
            let existing = try? JSONDecoder().decode([Session].self, from: data),
            let first = existing.first
        {
            return first.id
        }

        let body = try? JSONSerialization.data(
            withJSONObject: ["argv": [], "cols": 100, "rows": 30])
        guard let (data, _) = try? await session.data(for: request("POST", "/v1/sessions", body: body)),
            let made = try? JSONDecoder().decode(Session.self, from: data)
        else { return nil }
        return made.id
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
        let session =
            config.insecure
            ? URLSession(configuration: .default)
            : URLSession(
                configuration: .default,
                delegate: PinnedTrust(fingerprint: config.fingerprint), delegateQueue: nil)
        cache[config] = session
        return session
    }
}

/// The terminal on its own, fed by a fixture.
///
/// Reachable with `--fixture stress`, `--fixture vim` or `--fixture top`, and
/// it exists so the renderer can be worked on and measured without an account,
/// a box or a network. It goes through the same `LiveSession`, the same engine
/// and the same view as a real terminal — a harness that took a different route
/// through the app would be measuring a renderer nobody runs.
struct Harness: View {
    /// A canned stream, or nothing when the source is a real daemon that has
    /// to be asked for a session first.
    var source: ByteSource?
    var daemon: DaemonConfig?

    @StateObject private var store = SessionStore()
    @State private var session: LiveSession?
    @State private var problem: String?

    var body: some View {
        Group {
            if let session {
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Pill(
                            text: daemon == nil ? "fixture" : "local daemon",
                            tint: Design.theme.warning.color, icon: "wrench")
                        Text(
                            daemon.map { "\($0.host):\($0.port)" }
                                ?? "no daemon; input goes nowhere"
                        )
                        .font(Design.mono(11))
                        .foregroundStyle(Design.theme.faint.color)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Design.theme.surface.color)
                    Divider().overlay(Design.theme.border.color)
                    TerminalPane(
                        session: session, theme: Design.theme,
                        onOpenURL: { _ in }, onNewSession: {}, onCloseSession: {},
                        onPickSession: { _ in }
                    )
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                }
            } else {
                EmptyPane(
                    icon: problem == nil ? "wrench.and.screwdriver" : "exclamationmark.triangle",
                    title: problem ?? "Attaching…",
                    detail: problem == nil ? nil : "Is devpiped running?"
                ) { EmptyView() }
            }
        }
        .background(Design.theme.background.color)
        .task {
            if let source {
                session = store.session(for: "harness") { source }
                return
            }
            guard let daemon else { return }
            guard let id = await LocalDaemon.attachableSession(daemon) else {
                problem = "No session on \(daemon.host):\(daemon.port)"
                return
            }
            session = store.session(for: id) {
                WebSocketSource(config: daemon, sessionId: id)
            }
        }
    }
}
