import Foundation
import UIKit

/// Turning key presses into the bytes a pty expects.
///
/// This is where an iPad terminal is won or lost. Claude Code's TUI needs Esc
/// to interrupt, Ctrl+C to kill, arrows to move through history, and
/// Shift+Tab to cycle permission modes — and the iOS software keyboard offers
/// exactly none of them. Everything below exists to put those keys back.
enum Keys {
    struct Modes {
        let cursorApp: Bool
        let keypadApp: Bool
        let bracketedPaste: Bool

        init(raw: UInt32) {
            cursorApp = raw & 1 != 0
            keypadApp = raw & 2 != 0
            bracketedPaste = raw & 4 != 0
        }
    }

    enum Special {
        case up, down, left, right
        case home, end, pageUp, pageDown, delete, insert
        case escape, tab, backTab, enter, backspace
        case f(Int)
    }

    /// A TUI that set DECCKM wants `ESC O A` for up; a shell prompt wants
    /// `ESC [ A`. Sending the wrong one is silently ignored rather than
    /// erroring, which makes it a miserable bug to chase.
    static func bytes(for key: Special, modes: Modes) -> Data {
        let csi = "\u{1b}["
        let ss3 = modes.cursorApp ? "\u{1b}O" : "\u{1b}["

        switch key {
        case .up: return Data("\(ss3)A".utf8)
        case .down: return Data("\(ss3)B".utf8)
        case .right: return Data("\(ss3)C".utf8)
        case .left: return Data("\(ss3)D".utf8)
        case .home: return Data("\(ss3)H".utf8)
        case .end: return Data("\(ss3)F".utf8)
        case .pageUp: return Data("\(csi)5~".utf8)
        case .pageDown: return Data("\(csi)6~".utf8)
        case .insert: return Data("\(csi)2~".utf8)
        case .delete: return Data("\(csi)3~".utf8)
        case .escape: return Data([0x1b])
        case .tab: return Data([0x09])
        case .backTab: return Data("\(csi)Z".utf8)
        // Carriage return, not newline: the pty's line discipline turns CR
        // into the newline the program sees. Sending LF skips that and many
        // TUIs never see the Enter at all.
        case .enter: return Data([0x0d])
        case .backspace: return Data([0x7f])
        case .f(let n) where (1...4).contains(n):
            return Data("\u{1b}O\(["P", "Q", "R", "S"][n - 1])".utf8)
        case .f(let n):
            let code = [5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24][n] ?? 15
            return Data("\(csi)\(code)~".utf8)
        }
    }

    /// Ctrl collapses a letter to its low five bits: Ctrl+C is 0x03, and
    /// that is the byte that interrupts whatever is running.
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

    /// Alt/Option prefixes with Esc, which is how readline and every TUI
    /// built on it read meta.
    static func alt(_ text: String) -> Data {
        Data([0x1b]) + Data(text.utf8)
    }

    /// Wrapping a paste tells the receiver it is pasted text rather than
    /// typed, so a shell does not run each line as it arrives.
    static func paste(_ text: String, modes: Modes) -> Data {
        guard modes.bracketedPaste else { return Data(text.utf8) }
        return Data("\u{1b}[200~".utf8) + Data(text.utf8) + Data("\u{1b}[201~".utf8)
    }

    /// Maps a hardware keyboard press. Returns nil for keys the caller should
    /// let fall through to normal text input.
    static func fromPress(_ key: UIKey, modes: Modes) -> Data? {
        let mods = key.modifierFlags

        let special: Special? = switch key.keyCode {
        case .keyboardUpArrow: .up
        case .keyboardDownArrow: .down
        case .keyboardLeftArrow: .left
        case .keyboardRightArrow: .right
        case .keyboardHome: .home
        case .keyboardEnd: .end
        case .keyboardPageUp: .pageUp
        case .keyboardPageDown: .pageDown
        case .keyboardDeleteForward: .delete
        case .keyboardInsert: .insert
        case .keyboardEscape: .escape
        case .keyboardTab: mods.contains(.shift) ? .backTab : .tab
        case .keyboardReturnOrEnter: .enter
        case .keyboardDeleteOrBackspace: .backspace
        case .keyboardF1: .f(1)
        case .keyboardF2: .f(2)
        case .keyboardF3: .f(3)
        case .keyboardF4: .f(4)
        case .keyboardF5: .f(5)
        case .keyboardF6: .f(6)
        case .keyboardF7: .f(7)
        case .keyboardF8: .f(8)
        case .keyboardF9: .f(9)
        case .keyboardF10: .f(10)
        case .keyboardF11: .f(11)
        case .keyboardF12: .f(12)
        default: nil
        }
        if let special { return bytes(for: special, modes: modes) }

        let chars = key.charactersIgnoringModifiers
        guard let first = chars.first else { return nil }

        if mods.contains(.control) {
            if let data = control(first) {
                return mods.contains(.alternate) ? Data([0x1b]) + data : data
            }
            return nil
        }
        if mods.contains(.alternate), !chars.isEmpty {
            return alt(key.characters.isEmpty ? chars : key.characters)
        }
        return nil  // plain text goes through UIKeyInput
    }
}
