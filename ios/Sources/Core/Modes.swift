import Foundation

/// Everything a client needs to encode input, unpacked from
/// `dp_term_key_modes`.
///
/// One struct rather than two, because the keyboard and the pointer cannot be
/// encoded independently: what the wheel should do depends on whether the
/// program is reading the mouse, and if it is not, on whether the alternate
/// screen is up, and if it is, on whether the cursor keys are in application
/// mode. Splitting them is how you end up with a wheel that works at a shell
/// prompt and does nothing inside the pager.
struct TerminalModes: Equatable {
    let cursorApp: Bool
    let keypadApp: Bool
    let bracketedPaste: Bool
    let altScreen: Bool
    /// The program has asked to be told about clicks at all.
    let reportClick: Bool
    /// …and about motion while a button is held.
    let reportDrag: Bool
    /// …and about motion with no button held.
    let reportMotion: Bool
    /// SGR encoding (?1006) rather than the X10 fallback.
    let sgr: Bool
    /// ?1007: on the alternate screen, the wheel becomes arrow keys.
    let altScroll: Bool

    init(raw: UInt32) {
        cursorApp = raw & 1 != 0
        keypadApp = raw & 2 != 0
        bracketedPaste = raw & 4 != 0
        altScreen = raw & 8 != 0
        // 1002 and 1003 each imply the one below them.
        reportClick = raw & (16 | 32 | 64) != 0
        reportDrag = raw & (32 | 64) != 0
        reportMotion = raw & 64 != 0
        sgr = raw & 128 != 0
        altScroll = raw & 256 != 0
    }

    static let none = TerminalModes(raw: 0)
}
