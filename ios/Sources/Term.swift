import Foundation

/// Swift's side of the C ABI. Holds the emulator and hands the renderer a
/// borrowed view of the packed grid — nothing is copied out of Rust per frame.
final class Term {
    private var handle: OpaquePointer?
    private(set) var cols: Int
    private(set) var rows: Int
    private let scrollback: Int

    /// Scratch for the damage list so a frame does not allocate.
    private var damageScratch: [UInt32]

    init(cols: Int, rows: Int, scrollback: Int = 10_000) {
        self.cols = cols
        self.rows = rows
        self.scrollback = scrollback
        self.damageScratch = Array(repeating: 0, count: max(rows, 1))
        handle = dp_term_new(UInt32(cols), UInt32(rows), UInt32(scrollback))
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

    func resize(cols: Int, rows: Int) {
        guard let h = raw, cols > 0, rows > 0 else { return }
        self.cols = cols
        self.rows = rows
        if damageScratch.count < rows { damageScratch = Array(repeating: 0, count: rows) }
        dp_term_resize(h, UInt32(cols), UInt32(rows))
    }

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

    /// Throw away all state and start clean at the same size. Switching
    /// sessions without this leaves the previous session's screen underneath
    /// whatever the new one paints.
    func reset() {
        if let h = handle { dp_term_free(h) }
        handle = dp_term_new(UInt32(cols), UInt32(rows), UInt32(scrollback))
    }

    /// Bits the key encoder needs; see `dp_term_key_modes`.
    var keyModes: UInt32 {
        guard let h = raw else { return 0 }
        return dp_term_key_modes(h)
    }

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

    /// Bytes the emulator owes the pty. Answering these is not optional:
    /// a program that asks for the cursor position and never gets a reply
    /// hangs, and that includes things Claude Code shells out to.
    func takeOutput() -> Data? {
        guard let h = raw else { return nil }
        var len = 0
        guard let p = dp_term_take_output(h, &len), len > 0 else { return nil }
        return Data(bytes: p, count: len)
    }

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
