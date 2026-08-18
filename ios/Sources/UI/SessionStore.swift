import Foundation
import SwiftUI

/// One attached terminal: the emulator, the socket, and what to call it.
///
/// Kept alive when you switch away, which is the whole point. Detaching and
/// reattaching works — the daemon replays the screen — but it costs a round
/// trip and a full repaint every time you glance at another pane, and anything
/// that scrolled past while you were gone is gone. Holding the socket open
/// means switching terminals is instant and a build that finishes in a pane you
/// are not looking at is already there when you look.
@MainActor
final class LiveSession: ObservableObject, Identifiable {
    let id: String
    let engine: Engine
    private let transport: ByteSource

    @Published private(set) var state: TransportState = .idle
    /// The child's own title, when it sets one. A running agent labels its own
    /// pane this way.
    @Published private(set) var title: String?
    /// Something happened here while you were looking somewhere else.
    @Published var unread = false
    /// The viewport is parked in history, so new output is arriving where the
    /// reader cannot see it. Worth saying out loud, and worth offering a way
    /// back from.
    @Published var scrolledBack = false
    /// An agent raised OSC 9 asking for a human.
    @Published var attention: Term.Notification?

    private(set) var lastUsed = Date()

    /// Any byte source, so the render harness and a real box go down exactly
    /// the same path. A fixture that took a different route through the app
    /// would measure a renderer nobody runs.
    init(id: String, source: ByteSource, theme: Theme) {
        self.id = id
        self.engine = Engine(scrollback: Settings.shared.scrollback, theme: theme)
        self.transport = source

        // Weak both ways. The socket's handler holds the emulator and the
        // emulator's handler holds the socket, so capturing either strongly is
        // a cycle that outlives this object — and what leaks is an emulator
        // with up to two hundred thousand lines of scrollback behind it, once
        // per terminal anybody ever closed.
        transport.onBytes = { [weak engine] data in engine?.receive(data) }
        transport.onState = { [weak self, id] state in
            // The connection's whole life, in one line each. Enough to tell a
            // box that never answered from one that answered and dropped,
            // which from the outside look identical.
            trace("session \(id): \(state.label)")
            DispatchQueue.main.async { self?.state = state }
        }
        // Keystrokes and whatever the emulator owes the pty both go out here.
        engine.onOutbound = { [weak transport] data in transport?.send(data) }
        // And the grid size, which is the link that matters most and the
        // easiest to leave unconnected: everything looks fine until a line is
        // long enough to reach the width the two sides disagree about.
        //
        // Nothing resets the emulator on `resync`. The daemon's replay opens
        // with `ESC[H ESC[2J` and repaints the screen itself, so clearing first
        // buys nothing — and it cannot be done safely from here anyway: the
        // control frame arrives on the socket thread and hops to main, while
        // the replay bytes that follow it go straight into the inbox, so a
        // reset raced the very output it was meant to make room for.
        engine.onResize = { [weak transport, id] cols, rows in
            trace("session \(id): grid \(cols)x\(rows)")
            transport?.resize(cols: cols, rows: rows)
        }

        transport.start()
    }

    deinit {
        transport.stop()
    }

    func touch() {
        lastUsed = Date()
        unread = false
        attention = nil
    }

    func setTitle(_ title: String) {
        self.title = title.isEmpty ? nil : title
    }

    func stop() {
        transport.stop()
    }
}

/// The live sessions, keyed by id.
///
/// Bounded, because each one owns an emulator with ten thousand lines of
/// scrollback behind it. Eight is far more terminals than anyone drives from a
/// tablet, and the least recently looked at is the one to let go of.
@MainActor
final class SessionStore: ObservableObject {
    private var live: [String: LiveSession] = [:]
    private let limit = 8
    var theme: Theme = .dark

    func session(for id: String, connection: Control.Connection) -> LiveSession {
        session(for: id) {
            WebSocketSource(
                config: DaemonConfig(
                    host: connection.url
                        .replacingOccurrences(of: "wss://", with: "")
                        .replacingOccurrences(of: "ws://", with: ""),
                    port: 443,
                    token: connection.token,
                    fingerprint: "",
                    insecure: false),
                sessionId: id)
        }
    }

    func session(for id: String, source: () -> ByteSource) -> LiveSession {
        if let existing = live[id] {
            existing.touch()
            return existing
        }
        let made = LiveSession(id: id, source: source(), theme: theme)
        live[id] = made
        evictIfNeeded(keeping: id)
        return made
    }

    func existing(_ id: String) -> LiveSession? { live[id] }

    var all: [LiveSession] { Array(live.values) }

    func drop(_ id: String) {
        live.removeValue(forKey: id)?.stop()
    }

    func dropAll() {
        for session in live.values { session.stop() }
        live.removeAll()
    }

    /// Sessions the control plane no longer lists are gone; holding their
    /// sockets open would retry forever against an id that does not exist.
    func prune(keeping ids: Set<String>) {
        for id in live.keys where !ids.contains(id) { drop(id) }
    }

    private func evictIfNeeded(keeping id: String) {
        guard live.count > limit else { return }
        let victims = live.values
            .filter { $0.id != id }
            .sorted { $0.lastUsed < $1.lastUsed }
            .prefix(live.count - limit)
        for victim in victims { drop(victim.id) }
    }
}
