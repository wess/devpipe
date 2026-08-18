import Foundation
import OSLog

/// Readable from the host with:
///   xcrun simctl spawn <udid> log show --info --last 1m \
///     --predicate 'subsystem == "io.wess.devpipe"'
let log = Logger(subsystem: "io.wess.devpipe", category: "app")

/// Says it twice, on purpose.
///
/// `Logger` goes to the unified log, which is the right place for it and is
/// also unreachable from a Mac: `log stream --device-udid` no longer exists and
/// `devicectl` has no equivalent. What a connected Mac *can* read is the
/// process's stdout, over `devicectl device process launch --console`. So
/// anything worth diagnosing from outside goes to both.
///
/// This is not academic. The terminal stayed blank because every websocket was
/// being cancelled by the pin check, and the app knew — it reported
/// "reconnecting in 4s" to a logger nothing was reading. One line on stdout
/// would have named it in seconds rather than after reading the TLS delegate.
///
/// Never called with anything typed into a terminal. Keystrokes carry passwords
/// and tokens; `Daemon.swift` says why that path stays silent.
/// `notice`, not `info`. The unified log keeps `info` in memory and drops it,
/// so a line written at that level is gone by the time anybody asks what
/// happened — which is the only time these are ever read. `notice` is the
/// lowest level that persists, and this is a handful of lines per session
/// rather than anything that needs rationing.
func trace(_ what: String) {
    log.notice("\(what, privacy: .public)")
    print("[devpipe] \(what)")
    // Line-buffered when it is a pipe, which is exactly the case that matters.
    fflush(stdout)
}
