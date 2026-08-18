import UIKit

/// Text and key input.
///
/// Four separate paths have to work, and they are easy to get subtly wrong:
/// the software keyboard (`UIKeyInput`), a hardware keyboard (`pressesBegan`),
/// the accessory row that supplies the keys iOS refuses to show, and the
/// Command shortcuts a Magic Keyboard user will try within the first minute.
extension TerminalView: UIKeyInput {
    var hasText: Bool { true }

    func insertText(_ text: String) {
        // A latched Ctrl from the accessory row turns the next character into a
        // control byte, which is how Ctrl+C works without a Ctrl key.
        if controlLatched, let first = text.first {
            controlLatched = false
            if let data = Keys.control(first) {
                sendToPty(data)
                return
            }
        }
        // The software keyboard hands over "\n" for return; a pty wants CR.
        if text == "\n" {
            sendToPty(Keys.bytes(for: .enter, modes: modes))
            return
        }
        // Anything longer than a keystroke came from paste or dictation and
        // should be bracketed, so a shell does not run it line by line as it
        // arrives.
        if text.count > 1 {
            sendToPty(Keys.paste(text, modes: modes))
            return
        }
        sendToPty(Data(text.utf8))
    }

    func deleteBackward() {
        sendToPty(Keys.bytes(for: .backspace, modes: modes))
    }

    // A terminal is not a text field: no autocorrect, no capitalisation, and no
    // smart quotes, which would otherwise turn a typed `"` into `"` and break
    // every quoted shell argument.
    var autocorrectionType: UITextAutocorrectionType {
        get { .no }
        set {}
    }
    var autocapitalizationType: UITextAutocapitalizationType {
        get { .none }
        set {}
    }
    var smartQuotesType: UITextSmartQuotesType {
        get { .no }
        set {}
    }
    var smartDashesType: UITextSmartDashesType {
        get { .no }
        set {}
    }
    var smartInsertDeleteType: UITextSmartInsertDeleteType {
        get { .no }
        set {}
    }
    var spellCheckingType: UITextSpellCheckingType {
        get { .no }
        set {}
    }
    var keyboardAppearance: UIKeyboardAppearance {
        get { .dark }
        set {}
    }
    var returnKeyType: UIReturnKeyType {
        get { .default }
        set {}
    }
}

extension TerminalView {
    override var inputAccessoryView: UIView? { keyBar }

    /// Everything typed goes out through here so it can pull the view back to
    /// the live bottom first. Sending a keystroke while parked in history and
    /// seeing nothing happen reads as a hung terminal.
    func sendToPty(_ data: Data) {
        engine.send(data)
    }

    func send(_ key: Keys.Special, modifiers: Keys.Modifiers = Keys.Modifiers()) {
        var modifiers = modifiers
        if controlLatched {
            controlLatched = false
            modifiers.control = true
        }
        sendToPty(Keys.bytes(for: key, modes: modes, modifiers: modifiers))
    }

    // MARK: - hardware keyboard

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key else { continue }
            if let data = Keys.fromPress(key, modes: modes) {
                sendToPty(data)
                handled = true
            }
        }
        // Unhandled presses must fall through, or plain typing on a hardware
        // keyboard stops reaching `insertText` and the Command shortcuts below
        // never fire.
        if !handled { super.pressesBegan(presses, with: event) }
    }

    // MARK: - command shortcuts

    /// What a Magic Keyboard user will try in the first minute. Without these
    /// the iPad's best input device is worse than its worst one.
    override var keyCommands: [UIKeyCommand]? {
        func command(
            _ title: String, _ input: String, _ flags: UIKeyModifierFlags = .command,
            _ action: Selector
        ) -> UIKeyCommand {
            let key = UIKeyCommand(title: title, action: action, input: input, modifierFlags: flags)
            // Otherwise iOS flashes the shortcut overlay on every press.
            key.wantsPriorityOverSystemBehavior = true
            return key
        }

        var commands = [
            command("Copy", "c", .command, #selector(copy(_:))),
            command("Paste", "v", .command, #selector(paste(_:))),
            command("Find", "f", .command, #selector(startFind)),
            command("Clear", "k", .command, #selector(clearScreen)),
            command("New Terminal", "t", .command, #selector(newSession)),
            command("Close Terminal", "w", .command, #selector(closeSession)),
            command("Bigger Text", "+", .command, #selector(growFont)),
            command("Bigger Text", "=", .command, #selector(growFont)),
            command("Smaller Text", "-", .command, #selector(shrinkFont)),
            command("Actual Size", "0", .command, #selector(resetFont)),
            command("Page Up", UIKeyCommand.inputUpArrow, .command, #selector(pageUp)),
            command("Page Down", UIKeyCommand.inputDownArrow, .command, #selector(pageDown)),
        ]
        // Cmd+1…9 picks a terminal, the way every tabbed thing does.
        for n in 1...9 {
            commands.append(command("Terminal \(n)", "\(n)", .command, #selector(pickSession(_:))))
        }
        return commands
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        switch action {
        case #selector(copy(_:)):
            return hasSelection
        case #selector(paste(_:)):
            return UIPasteboard.general.hasStrings
        default:
            return super.canPerformAction(action, withSender: sender)
        }
    }

    /// The real work, reachable without going through `copy(_:)`.
    ///
    /// `copy(_:)` is a `UIResponderStandardEditActions` requirement, and a menu
    /// action calling it back through the responder chain is one indirection
    /// more than this needs. Having a plain method means the edit menu, the
    /// key command and the responder chain all land in the same place and
    /// there is one thing to be wrong rather than three.
    func copySelection() {
        engine.selectionText { [weak self] text in
            guard let self, let text, !text.isEmpty else { return }
            UIPasteboard.general.string = text
            engine.clearSelection()
            Haptics.tap()
        }
    }

    override func copy(_ sender: Any?) {
        copySelection()
    }

    override func paste(_ sender: Any?) {
        pasteFromClipboard()
    }

    /// The OAuth step ends by asking for a code that is, by construction, on
    /// the clipboard — the browser put it there. Bracketed so a shell treats it
    /// as pasted text rather than typing.
    func pasteFromClipboard() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        sendToPty(Keys.paste(text, modes: modes))
    }

    @objc private func startFind() {
        terminalDelegate?.terminalViewWantsFind(self)
    }

    @objc private func newSession() {
        terminalDelegate?.terminalViewWantsNewSession(self)
    }

    @objc private func closeSession() {
        terminalDelegate?.terminalViewWantsCloseSession(self)
    }

    @objc private func pickSession(_ sender: UIKeyCommand) {
        guard let n = sender.input.flatMap(Int.init), n >= 1 else { return }
        terminalDelegate?.terminalView(self, wantsSessionAt: n - 1)
    }

    /// Ctrl+L, which is what a shell understands. Clearing our own scrollback
    /// instead would leave the shell's idea of the screen intact and the next
    /// prompt would redraw over nothing.
    @objc private func clearScreen() {
        sendToPty(Data([0x0c]))
    }

    @objc private func growFont() { fontSize += 1 }
    @objc private func shrinkFont() { fontSize -= 1 }
    @objc private func resetFont() { fontSize = 13 }

    @objc private func pageUp() {
        engine.scroll(rows: max(1, frame_.rows - 2))
    }

    @objc private func pageDown() {
        engine.scroll(rows: -max(1, frame_.rows - 2))
    }
}
