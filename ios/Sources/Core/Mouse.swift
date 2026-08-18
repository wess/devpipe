import Foundation

/// Turning pointer gestures into the bytes a program expects.
///
/// The iPad client sent none of this, which is why the wheel and the trackpad
/// appeared broken. A full-screen program runs on the alternate screen, the
/// alternate screen keeps no scrollback, and the client only knew how to move
/// through scrollback — so inside the one kind of program this product exists
/// to run, the pointer did nothing at all.
///
/// Deliberately the same arithmetic as the web client's `mouse.ts`, so the two
/// cannot disagree about what a click means.
enum Mouse {
    /// Button numbers as the wire format counts them.
    enum Button: Int {
        case left = 0
        case middle = 1
        case right = 2
        case wheelUp = 64
        case wheelDown = 65
    }

    struct Modifiers {
        var shift = false
        var alt = false
        var control = false

        var offset: Int {
            (shift ? 4 : 0) + (alt ? 8 : 0) + (control ? 16 : 0)
        }
    }

    /// One pointer event.
    ///
    /// SGR (?1006) when the program asked for it, X10 otherwise. X10 is the
    /// fallback rather than the default because it encodes a coordinate as
    /// `32 + n` in a single byte and so cannot express a column past 223 — on
    /// an iPad-width terminal that is most of the screen, and the failure is a
    /// click landing somewhere else entirely rather than an error.
    static func report(
        _ modes: TerminalModes, button: Int, col: Int, row: Int, pressed: Bool,
        modifiers: Modifiers = Modifiers()
    ) -> Data? {
        guard modes.reportClick else { return nil }

        // Columns and rows are 1-based on the wire.
        let x = col + 1
        let y = row + 1
        let code = button + modifiers.offset

        if modes.sgr {
            return Data("\u{1b}[<\(code);\(x);\(y)\(pressed ? "M" : "m")".utf8)
        }
        // X10 has no release button, only "something went up" — 3.
        let legacy = pressed ? code : 3
        guard x <= 223, y <= 223, legacy + 32 <= 255 else { return nil }
        return Data([0x1b, 0x5b, 0x4d, UInt8(32 + legacy), UInt8(32 + x), UInt8(32 + y)])
    }

    /// Motion, which only some modes want to hear about.
    static func motion(
        _ modes: TerminalModes, button: Int, col: Int, row: Int, held: Bool
    ) -> Data? {
        guard modes.reportMotion || (modes.reportDrag && held) else { return nil }
        // 32 marks the event as motion rather than a fresh press.
        return report(modes, button: (held ? button : 3) + 32, col: col, row: row, pressed: true)
    }

    /// What the wheel should do, given what the program has asked for.
    enum WheelAction: Equatable {
        /// Send these bytes: either a mouse report or the arrow keys the
        /// alternate screen wants instead.
        case send(Data)
        /// Move the local viewport through scrollback.
        case scrollback(lines: Int)
        /// Nothing to do.
        case ignore
    }

    /// Three cases, in the order every other terminal resolves them:
    ///
    ///  - the program is reading the mouse, so send it the wheel and let it
    ///    decide;
    ///  - the alternate screen with alternate scroll, where there is no
    ///    scrollback to move through, so the wheel becomes arrow keys — which
    ///    is what makes a pager or a TUI list scroll at all;
    ///  - anything else, which means move the local view through history.
    static func wheel(
        _ modes: TerminalModes, lines: Int, col: Int, row: Int, hasScrollback: Bool
    ) -> WheelAction {
        guard lines != 0 else { return .ignore }
        let up = lines < 0
        let count = min(abs(lines), 10)

        if modes.reportClick {
            let button = (up ? Button.wheelUp : Button.wheelDown).rawValue
            var out = Data()
            for _ in 0..<count {
                if let one = report(modes, button: button, col: col, row: row, pressed: true) {
                    out.append(one)
                }
            }
            if !out.isEmpty { return .send(out) }
        }

        if modes.altScreen {
            guard modes.altScroll else { return .ignore }
            // Arrow keys, three rows per notch — xterm's ratio, and what the
            // programs that read them are tuned for.
            //
            // In the spelling the program actually asked for: a TUI that has
            // set DECCKM expects `ESC O A` and ignores `ESC [ A`, and getting
            // that wrong makes the wheel dead again in a way indistinguishable
            // from sending nothing.
            let sequence =
                modes.cursorApp
                ? (up ? "\u{1b}OA" : "\u{1b}OB")
                : (up ? "\u{1b}[A" : "\u{1b}[B")
            return .send(Data(String(repeating: sequence, count: count * 3).utf8))
        }

        guard hasScrollback else { return .ignore }
        return .scrollback(lines: lines)
    }
}
