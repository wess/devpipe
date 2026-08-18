import Foundation

/// Swift's side of the C ABI.
///
/// **One owner, one thread.** Nothing here is synchronised, and it must not be:
/// every entry point takes `&mut DpTerm` on the Rust side, so two threads
/// touching the same `Term` is undefined behaviour, not a race you get away
/// with. It used to be exactly that — the websocket delivered bytes on
/// URLSession's delegate queue and called `feed` there, while the display link
/// called `takeDamage` and `snapshot` on the main thread. The crashes that came
/// of it landed nowhere near the cause.
///
/// `Engine` is the owner. Everything else goes through it.
final class Term {
    private var handle: OpaquePointer?
    private(set) var cols: Int
    private(set) var rows: Int
    private let scrollback: Int

    /// Scratch for the damage list so a frame does not allocate.
    private var damageScratch: [UInt32]

    init(cols: Int, rows: Int, scrollback: Int = 10_000) {
        self.cols = max(cols, 1)
        self.rows = max(rows, 1)
        self.scrollback = scrollback
        self.damageScratch = Array(repeating: 0, count: max(rows, 1))
        handle = dp_term_new(UInt32(self.cols), UInt32(self.rows), UInt32(scrollback))
    }

    deinit {
        if let h = handle { dp_term_free(h) }
    }

    /// The C side declares `DpTerm` as an incomplete type, so Swift sees it as
    /// an `OpaquePointer` rather than a struct pointer. That is the shape we
    /// want anyway — the layout is Rust's business.
    private var raw: OpaquePointer? { handle }

    func feed(_ data: Data) {
        guard let h = raw, !data.isEmpty else { return }
        data.withUnsafeBytes { buf in
            guard let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            dp_term_feed(h, base, buf.count)
        }
    }

    func feed(_ bytes: UnsafeRawBufferPointer) {
        guard let h = raw, !bytes.isEmpty,
              let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self)
        else { return }
        dp_term_feed(h, base, bytes.count)
    }

    func resize(cols: Int, rows: Int) {
        guard let h = raw, cols > 0, rows > 0 else { return }
        self.cols = cols
        self.rows = rows
        if damageScratch.count < rows { damageScratch = Array(repeating: 0, count: rows) }
        dp_term_resize(h, UInt32(cols), UInt32(rows))
    }

    /// Throw away all state and start clean at the same size.
    ///
    /// In place — the handle does not move. The old version freed and
    /// reallocated, which left anything holding the last snapshot pointer
    /// reading freed memory.
    func reset() {
        guard let h = raw else { return }
        dp_term_reset(h)
    }

    // MARK: - viewport

    /// Positive scrolls back into history, negative toward the live bottom.
    /// Both clamp, so a caller can throw a large delta at it to reach an end.
    func scroll(_ delta: Int) {
        guard let h = raw else { return }
        dp_term_scroll(h, delta)
    }

    /// Rows the view sits above the live bottom; 0 is the running screen.
    var displayOffset: Int {
        guard let h = raw else { return 0 }
        return dp_term_display_offset(h)
    }

    func setDisplayOffset(_ offset: Int) {
        guard let h = raw else { return }
        dp_term_set_display_offset(h, max(0, offset))
    }

    /// Rows of history behind the screen. Zero on the alternate screen, which
    /// keeps none — a TUI owns the viewport and there is nothing to scroll.
    var scrollbackLength: Int {
        guard let h = raw else { return 0 }
        return dp_term_scrollback_len(h)
    }

    var atBottom: Bool { displayOffset == 0 }

    /// The core never follows the tail on its own — a scrolled-back view holds
    /// the rows it was showing however much output arrives — so returning to
    /// live is always something the client asks for.
    func scrollToBottom() {
        guard let h = raw else { return }
        dp_term_scroll_to_bottom(h)
    }

    // MARK: - modes

    /// Bits the key and pointer encoders need; see `dp_term_key_modes`.
    var keyModes: UInt32 {
        guard let h = raw else { return 0 }
        return dp_term_key_modes(h)
    }

    /// The program has bracketed a multi-write repaint (?2026) and the frame
    /// should be held until it closes, or the user sees the half-drawn state.
    var holdingFrame: Bool {
        guard let h = raw else { return false }
        return dp_term_synchronized_output(h) != 0
    }

    func reportFocus(_ focused: Bool) {
        guard let h = raw else { return }
        dp_term_report_focus(h, focused ? 1 : 0)
    }

    // MARK: - links

    struct Link {
        let url: URL
        let row: Int
        let startCol: Int
        let endCol: Int
    }

    /// The link under a cell, if there is one.
    func link(row: Int, col: Int) -> Link? {
        guard let h = raw, row >= 0, col >= 0 else { return nil }
        var start: UInt32 = 0
        var end: UInt32 = 0
        guard let p = dp_term_link_at(h, UInt32(row), UInt32(col), &start, &end) else {
            return nil
        }
        let text = String(cString: p)
        // A terminal will happily print `file://` or `javascript:`; only hand
        // the system things it makes sense to open from a tap.
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http"
        else { return nil }
        return Link(url: url, row: row, startCol: Int(start), endCol: Int(end))
    }

    // MARK: - selection

    /// What a drag means. Matches `dp_term_selection_start`'s `mode`.
    enum SelectionMode: UInt32 {
        case cell = 0, word = 1, line = 2, smart = 3
    }

    /// Points are absolute content coordinates: `0..rows-1` is the live screen
    /// and negative lines run back into scrollback, so a visible row `r` at
    /// display offset `off` is line `r - off`.
    func line(forVisibleRow row: Int) -> Int { row - displayOffset }

    func startSelection(_ mode: SelectionMode, line: Int, col: Int) {
        guard let h = raw else { return }
        dp_term_selection_start(h, line, max(0, col), mode.rawValue)
    }

    func updateSelection(line: Int, col: Int) {
        guard let h = raw else { return }
        dp_term_selection_update(h, line, max(0, col))
    }

    func clearSelection() {
        guard let h = raw else { return }
        dp_term_selection_clear(h)
    }

    struct Span {
        let startLine: Int, startCol: Int
        let endLine: Int, endCol: Int
    }

    var selection: Span? {
        guard let h = raw else { return nil }
        var out = [Int](repeating: 0, count: 4)
        let has = out.withUnsafeMutableBufferPointer { buf in
            dp_term_selection_span(h, buf.baseAddress)
        }
        guard has != 0 else { return nil }
        return Span(startLine: out[0], startCol: out[1], endLine: out[2], endCol: out[3])
    }

    var selectionText: String? {
        guard let h = raw, let p = dp_term_selection_text(h) else { return nil }
        let text = String(cString: p)
        return text.isEmpty ? nil : text
    }

    // MARK: - events

    /// Drained by asking. Mirrors `DP_EVENT_*`.
    struct Events: OptionSet {
        let rawValue: UInt32
        static let bell = Events(rawValue: DP_EVENT_BELL)
        static let title = Events(rawValue: DP_EVENT_TITLE)
        static let cwd = Events(rawValue: DP_EVENT_CWD)
        static let clipboard = Events(rawValue: DP_EVENT_CLIPBOARD)
        static let notification = Events(rawValue: DP_EVENT_NOTIFICATION)
        static let commandDone = Events(rawValue: DP_EVENT_COMMAND_DONE)
    }

    func takeEvents() -> Events {
        guard let h = raw else { return [] }
        return Events(rawValue: dp_term_take_events(h))
    }

    var title: String {
        guard let h = raw, let p = dp_term_title(h) else { return "" }
        return String(cString: p)
    }

    var cwd: String? {
        guard let h = raw, let p = dp_term_cwd(h) else { return nil }
        return String(cString: p)
    }

    /// The payload of the last OSC 52 write, valid until the next event drain.
    var clipboardWrite: String? {
        guard let h = raw, let p = dp_term_clipboard(h) else { return nil }
        return String(cString: p)
    }

    /// What a program asked us to tell the human about. An agent that wants
    /// permission raises this, and it is the whole reason to leave one running
    /// on a box you are not looking at.
    struct Notification {
        let title: String
        let body: String
    }

    var notification: Notification? {
        guard let h = raw else { return nil }
        let title = dp_term_notification_title(h).map { String(cString: $0) } ?? ""
        let body = dp_term_notification_body(h).map { String(cString: $0) } ?? ""
        guard !title.isEmpty || !body.isEmpty else { return nil }
        return Notification(title: title, body: body)
    }

    /// Bytes the emulator owes the pty. Answering these is not optional:
    /// a program that asks for the cursor position and never gets a reply
    /// hangs, and that includes things Claude Code shells out to.
    func takeOutput() -> Data? {
        guard let h = raw else { return nil }
        var len = 0
        guard let p = dp_term_take_output(h, &len), len > 0 else { return nil }
        return Data(bytes: p, count: len)
    }

    // MARK: - search

    struct Match: Equatable {
        /// Global line: `0..<scrollbackLength` is history, then the live screen.
        let line: Int
        let startCol: Int
        let endCol: Int
    }

    /// Every occurrence across scrollback and the live screen.
    ///
    /// `limit` caps what comes back rather than what is counted, so a search
    /// that hits ten thousand times still reports ten thousand.
    func search(_ needle: String, caseSensitive: Bool = false, limit: Int = 2000)
        -> (matches: [Match], total: Int)
    {
        guard let h = raw, !needle.isEmpty else { return ([], 0) }
        var buffer = [DpMatch](repeating: DpMatch(), count: limit)
        let total = needle.withCString { c in
            buffer.withUnsafeMutableBufferPointer { buf in
                dp_term_search(h, c, caseSensitive ? 1 : 0, buf.baseAddress, buf.count)
            }
        }
        guard total > 0 else { return ([], 0) }
        let kept = min(Int(total), limit)
        let matches = buffer[0..<kept].map {
            Match(line: Int($0.line), startCol: Int($0.start_col), endCol: Int($0.end_col))
        }
        return (matches, Int(total))
    }

    // MARK: - damage and pixels

    enum Damage {
        case none
        case full
        case rows([UInt32])
    }

    func takeDamage() -> Damage {
        guard let h = raw else { return .none }
        let n = damageScratch.withUnsafeMutableBufferPointer { buf in
            dp_term_take_damage(h, buf.baseAddress, buf.count)
        }
        if n < 0 { return .full }
        if n == 0 { return .none }
        return .rows(Array(damageScratch[0..<Int(n)]))
    }

    /// Refreshes the packed grid and calls `body` with a borrowed view of it.
    /// The pointer dies at the next snapshot, so it never escapes the closure.
    func withSnapshot<T>(_ body: (DpScreen, UnsafeBufferPointer<DpCell>) -> T) -> T? {
        guard let h = raw else { return nil }
        var screen = DpScreen()
        guard let p = dp_term_snapshot(h, &screen) else { return nil }
        let count = Int(screen.cols) * Int(screen.rows)
        return body(screen, UnsafeBufferPointer(start: p, count: count))
    }
}
