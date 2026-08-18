import Foundation

/// Turning key presses into the bytes a pty expects.
///
/// This is where an iPad terminal is won or lost. Claude Code's TUI needs Esc
/// to interrupt, Ctrl+C to kill, arrows to move through history, and Shift+Tab
/// to cycle permission modes — and the iOS software keyboard offers exactly
/// none of them. Everything below exists to put those keys back.
enum Keys {
    typealias Modes = TerminalModes

    enum Special: Equatable {
        case up, down, left, right
        case home, end, pageUp, pageDown, delete, insert
        case escape, tab, backTab, enter, backspace
        case f(Int)
    }

    /// The modifier bias a CSI sequence carries: 1 plus a bit per modifier.
    /// `CSI 1;5 A` is Ctrl+Up, which is how a shell is told to jump a word.
    struct Modifiers: Equatable {
        var shift = false
        var alt = false
        var control = false

        var isEmpty: Bool { !shift && !alt && !control }

        /// Nil when there is nothing to say, so the caller emits the short
        /// unmodified form that every program understands.
        var csiParameter: Int? {
            guard !isEmpty else { return nil }
            return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (control ? 4 : 0)
        }

        init(shift: Bool = false, alt: Bool = false, control: Bool = false) {
            self.shift = shift
            self.alt = alt
            self.control = control
        }

    }

    /// A TUI that set DECCKM wants `ESC O A` for up; a shell prompt wants
    /// `ESC [ A`. Sending the wrong one is silently ignored rather than
    /// erroring, which makes it a miserable bug to chase.
    static func bytes(for key: Special, modes: Modes, modifiers: Modifiers = Modifiers()) -> Data {
        let csi = "\u{1b}["
        let modifier = modifiers.csiParameter

        /// `CSI 1;<mod> <final>` when modified; `SS3 <final>` or `CSI <final>`
        /// otherwise, depending on what the program asked for.
        func cursorKey(_ final: String) -> Data {
            if let modifier { return Data("\(csi)1;\(modifier)\(final)".utf8) }
            // Application mode only applies to the unmodified form; xterm sends
            // CSI for anything with a modifier on it whatever DECCKM says.
            return Data("\(modes.cursorApp ? "\u{1b}O" : csi)\(final)".utf8)
        }

        /// `CSI <n>;<mod> ~`, or `CSI <n> ~`.
        func tilde(_ number: Int) -> Data {
            if let modifier { return Data("\(csi)\(number);\(modifier)~".utf8) }
            return Data("\(csi)\(number)~".utf8)
        }

        switch key {
        case .up: return cursorKey("A")
        case .down: return cursorKey("B")
        case .right: return cursorKey("C")
        case .left: return cursorKey("D")
        case .home: return cursorKey("H")
        case .end: return cursorKey("F")
        case .pageUp: return tilde(5)
        case .pageDown: return tilde(6)
        case .insert: return tilde(2)
        case .delete: return tilde(3)
        case .escape: return Data([0x1b])
        case .tab: return modifiers.control ? Data("\(csi)9;5u".utf8) : Data([0x09])
        case .backTab: return Data("\(csi)Z".utf8)
        // Carriage return, not newline: the pty's line discipline turns CR into
        // the newline the program sees. Sending LF skips that and many TUIs
        // never see the Enter at all.
        //
        // Alt+Enter is how an agent's prompt is told "newline, not submit", and
        // it is the escape-prefixed form that says so.
        case .enter: return modifiers.alt ? Data([0x1b, 0x0d]) : Data([0x0d])
        case .backspace: return modifiers.alt ? Data([0x1b, 0x7f]) : Data([0x7f])
        case .f(let n) where (1...4).contains(n):
            let final = ["P", "Q", "R", "S"][n - 1]
            if let modifier { return Data("\(csi)1;\(modifier)\(final)".utf8) }
            return Data("\u{1b}O\(final)".utf8)
        case .f(let n):
            let code = [5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24][n] ?? 15
            return tilde(code)
        }
    }

    /// Ctrl collapses a letter to its low five bits: Ctrl+C is 0x03, and that
    /// is the byte that interrupts whatever is running.
    static func control(_ character: Character) -> Data? {
        guard let ascii = character.asciiValue else { return nil }
        let upper = ascii >= 97 && ascii <= 122 ? ascii - 32 : ascii
        switch upper {
        case 64...95: return Data([upper & 0x1f])  // @A-Z[\]^_
        case 63: return Data([0x7f])  // Ctrl+? is DEL
        case 32: return Data([0x00])  // Ctrl+Space is NUL
        default: return nil
        }
    }

    /// Alt/Option prefixes with Esc, which is how readline and every TUI built
    /// on it read meta.
    static func alt(_ text: String) -> Data {
        Data([0x1b]) + Data(text.utf8)
    }

    /// Wrapping a paste tells the receiver it is pasted text rather than typed,
    /// so a shell does not run each line as it arrives.
    ///
    /// The markers are stripped from the payload as well. Text containing
    /// `ESC[201~` would otherwise close the bracket early and hand the rest
    /// straight to the shell as commands — which is a paste-injection hole, not
    /// merely a formatting bug.
    static func paste(_ text: String, modes: Modes) -> Data {
        guard modes.bracketedPaste else { return Data(text.utf8) }
        let safe = text
            .replacingOccurrences(of: "\u{1b}[201~", with: "")
            .replacingOccurrences(of: "\u{1b}[200~", with: "")
        return Data("\u{1b}[200~".utf8) + Data(safe.utf8) + Data("\u{1b}[201~".utf8)
    }
}
