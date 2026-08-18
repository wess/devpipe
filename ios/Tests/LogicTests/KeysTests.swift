import XCTest

@testable import DevpipeLogic

/// What the pty is actually sent.
///
/// Every one of these is a key that was, or could be, silently dead. A wrong
/// escape is not an error anywhere in the stack: the program simply ignores a
/// sequence it does not recognise, so the key does nothing, in one mode, inside
/// one kind of program, and looks identical to sending nothing at all.
final class KeysTests: XCTestCase {
    private let plain = TerminalModes(raw: 0)
    private let cursorApp = TerminalModes(raw: 1)
    private let bracketed = TerminalModes(raw: 4)

    private func bytes(_ key: Keys.Special, _ modes: TerminalModes, _ mods: Keys.Modifiers = .init())
        -> String
    {
        String(decoding: Keys.bytes(for: key, modes: modes, modifiers: mods), as: UTF8.self)
    }

    func testArrowsFollowApplicationCursorMode() {
        // The bug this exists for: a TUI that has set DECCKM expects SS3 and
        // ignores CSI, so arrow keys die inside full-screen programs while
        // working fine at a shell prompt.
        XCTAssertEqual(bytes(.up, plain), "\u{1b}[A")
        XCTAssertEqual(bytes(.up, cursorApp), "\u{1b}OA")
        XCTAssertEqual(bytes(.down, cursorApp), "\u{1b}OB")
        XCTAssertEqual(bytes(.right, cursorApp), "\u{1b}OC")
        XCTAssertEqual(bytes(.left, cursorApp), "\u{1b}OD")
    }

    func testModifiedArrowsAlwaysUseCsiWhateverTheMode() {
        // xterm sends CSI for anything carrying a modifier even under DECCKM,
        // and a shell told to jump a word reads exactly this.
        let ctrl = Keys.Modifiers(control: true)
        XCTAssertEqual(bytes(.right, plain, ctrl), "\u{1b}[1;5C")
        XCTAssertEqual(bytes(.right, cursorApp, ctrl), "\u{1b}[1;5C")
        XCTAssertEqual(bytes(.left, plain, Keys.Modifiers(shift: true)), "\u{1b}[1;2D")
        XCTAssertEqual(bytes(.up, plain, Keys.Modifiers(alt: true)), "\u{1b}[1;3A")
    }

    func testEnterIsCarriageReturnNotNewline() {
        // The pty's line discipline turns CR into the newline the program sees.
        // Sending LF skips that and many TUIs never see the Enter at all.
        XCTAssertEqual(Keys.bytes(for: .enter, modes: plain), Data([0x0d]))
        // Alt+Enter is how an agent's prompt is told "newline, not submit".
        XCTAssertEqual(
            Keys.bytes(for: .enter, modes: plain, modifiers: Keys.Modifiers(alt: true)),
            Data([0x1b, 0x0d]))
    }

    func testShiftTabCyclesPermissionModes() {
        // Claude Code's TUI reads CSI Z for this, and nothing else.
        XCTAssertEqual(bytes(.backTab, plain), "\u{1b}[Z")
        XCTAssertEqual(bytes(.backTab, cursorApp), "\u{1b}[Z")
    }

    func testControlCollapsesToTheLowFiveBits() {
        XCTAssertEqual(Keys.control("c"), Data([0x03]), "the byte that interrupts")
        XCTAssertEqual(Keys.control("C"), Data([0x03]), "case cannot matter")
        XCTAssertEqual(Keys.control("d"), Data([0x04]))
        XCTAssertEqual(Keys.control("["), Data([0x1b]), "Ctrl+[ is Esc")
        XCTAssertEqual(Keys.control(" "), Data([0x00]), "Ctrl+Space is NUL")
        XCTAssertEqual(Keys.control("?"), Data([0x7f]), "Ctrl+? is DEL")
        XCTAssertNil(Keys.control("é"), "no ascii value, nothing to collapse")
    }

    func testBackspaceIsDeleteNotBackspace() {
        // 0x7f, not 0x08. Terminals have disagreed about this for forty years
        // and readline expects DEL.
        XCTAssertEqual(Keys.bytes(for: .backspace, modes: plain), Data([0x7f]))
    }

    func testFunctionKeys() {
        XCTAssertEqual(bytes(.f(1), plain), "\u{1b}OP")
        XCTAssertEqual(bytes(.f(4), plain), "\u{1b}OS")
        XCTAssertEqual(bytes(.f(5), plain), "\u{1b}[15~")
        XCTAssertEqual(bytes(.f(12), plain), "\u{1b}[24~")
    }

    func testPasteIsOnlyBracketedWhenTheProgramAskedForIt() {
        XCTAssertEqual(String(decoding: Keys.paste("ls", modes: plain), as: UTF8.self), "ls")
        XCTAssertEqual(
            String(decoding: Keys.paste("ls", modes: bracketed), as: UTF8.self),
            "\u{1b}[200~ls\u{1b}[201~")
    }

    func testPasteCannotBeUsedToCloseItsOwnBracket() {
        // Not a formatting bug: text carrying the end marker would hand
        // everything after it to the shell as typed input, which is the whole
        // shape of a paste-injection attack. A malicious README is enough.
        let hostile = "safe\u{1b}[201~rm -rf ~\r"
        let out = String(decoding: Keys.paste(hostile, modes: bracketed), as: UTF8.self)
        XCTAssertEqual(out, "\u{1b}[200~saferm -rf ~\r\u{1b}[201~")
        XCTAssertEqual(out.components(separatedBy: "\u{1b}[201~").count, 2, "exactly one end marker")
        XCTAssertEqual(out.components(separatedBy: "\u{1b}[200~").count, 2, "exactly one start")
    }
}
