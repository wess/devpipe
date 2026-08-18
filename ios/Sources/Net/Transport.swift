import Foundation

/// Where terminal bytes come from.
///
/// A websocket to a box for a real session, a canned capture for the render
/// harness. Neither the engine nor the renderer can tell them apart, which is
/// what makes the harness worth having: a live session is never the same twice
/// and a renderer you cannot measure is one you cannot improve.
protocol ByteSource: AnyObject {
    var onBytes: ((Data) -> Void)? { get set }
    var onState: ((TransportState) -> Void)? { get set }
    func start()
    func stop()
    func send(_ data: Data)
    func resize(cols: Int, rows: Int)
}

/// What the connection is doing, in terms the status line can show without
/// translating first.
enum TransportState: Equatable {
    case idle
    case connecting
    /// Attached, with the session id the daemon confirmed.
    case attached(String)
    /// The client fell behind and the daemon sent a fresh screen.
    case resynced
    case waiting(seconds: Int, reason: String)
    /// The child is gone. Terminal, in both senses: retrying would attach to
    /// nothing.
    case ended(String)

    var isLive: Bool {
        switch self {
        case .attached, .resynced: return true
        default: return false
        }
    }

    /// Deliberately plain. "Socket closed with error -1005" tells the user
    /// nothing they can act on.
    var label: String {
        switch self {
        case .idle: return "idle"
        case .connecting: return "connecting"
        case .attached: return "connected"
        case .resynced: return "caught up"
        case .waiting(let seconds, let reason):
            return seconds > 0 ? "\(reason) — retrying in \(seconds)s" : reason
        case .ended(let why): return why
        }
    }
}
