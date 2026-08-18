import UIKit

/// The UIKit half of key encoding: a `UIKey` turned into the modifiers and
/// the special key that `Keys` knows how to spell. Kept apart from the
/// encoder itself so the encoder compiles — and is tested — without a
/// window server anywhere near it.
extension Keys.Modifiers {
    init(_ flags: UIKeyModifierFlags) {
        self.init(
            shift: flags.contains(.shift),
            alt: flags.contains(.alternate),
            control: flags.contains(.control))
    }
}

extension Keys {
    /// Maps a hardware keyboard press.
    ///
    /// Returns nil for keys the caller should let fall through: plain text,
    /// which `UIKeyInput` handles, and anything with Command on it, which
    /// belongs to the app rather than to the terminal.
    static func fromPress(_ key: UIKey, modes: Modes) -> Data? {
        let flags = key.modifierFlags
        guard !flags.contains(.command) else { return nil }
        let modifiers = Modifiers(flags)

        let special: Special? =
            switch key.keyCode {
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
            case .keyboardTab: flags.contains(.shift) ? .backTab : .tab
            case .keyboardReturnOrEnter, .keypadEnter: .enter
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
        if let special {
            // Tab and back-tab already encode shift in the choice between them.
            var forwarded = modifiers
            if special == .tab || special == .backTab { forwarded.shift = false }
            return bytes(for: special, modes: modes, modifiers: forwarded)
        }

        let chars = key.charactersIgnoringModifiers
        guard let first = chars.first else { return nil }

        if flags.contains(.control) {
            guard let data = control(first) else { return nil }
            return flags.contains(.alternate) ? Data([0x1b]) + data : data
        }
        if flags.contains(.alternate) {
            // The unmodified characters: Option+F on a US layout produces "ƒ",
            // and what readline wants is Esc F.
            return alt(chars)
        }
        return nil  // plain text goes through UIKeyInput
    }
}
