import UIKit

/// Text and key input for the terminal view.
///
/// Three separate paths have to work, and they are easy to get subtly wrong:
/// the software keyboard (via `UIKeyInput`), a hardware keyboard (via
/// `pressesBegan`), and the accessory row that supplies the keys iOS refuses
/// to show — Esc, Ctrl, Tab, and the arrows.
extension TerminalUIView: UIKeyInput {
    var keyModes: Keys.Modes { Keys.Modes(raw: term?.keyModes ?? 0) }

    var hasText: Bool { true }

    func insertText(_ text: String) {
        // A latched Ctrl from the accessory row turns the next character into
        // a control byte, which is how Ctrl+C works without a Ctrl key.
        if let data = applyLatchedControl(text) {
            sendToPty(data)
            return
        }
        // The software keyboard hands over "\n" for return; a pty wants CR.
        if text == "\n" {
            sendToPty(Keys.bytes(for: .enter, modes: keyModes))
            return
        }
        // Anything longer than a keystroke came from paste or dictation, and
        // should be bracketed so a shell does not execute it line by line.
        if text.count > 1 {
            sendToPty(Keys.paste(text, modes: keyModes))
            return
        }
        sendToPty(Data(text.utf8))
    }

    func deleteBackward() {
        sendToPty(Keys.bytes(for: .backspace, modes: keyModes))
    }

    // A terminal is not a text field: no autocorrect, no capitalisation, and
    // no smart quotes, which would otherwise turn a typed `"` into `"` and
    // break every quoted shell argument.
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
    var spellCheckingType: UITextSpellCheckingType {
        get { .no }
        set {}
    }
    var keyboardAppearance: UIKeyboardAppearance {
        get { .dark }
        set {}
    }

    func send(_ key: Keys.Special) {
        sendToPty(Keys.bytes(for: key, modes: keyModes))
    }

    func sendControl(_ character: Character) {
        if let data = Keys.control(character) { sendToPty(data) }
    }
}

/// The row above the software keyboard. iOS gives an iPad terminal no Esc,
/// no Ctrl, and no arrows, so without this a coding agent's TUI cannot be
/// interrupted, cannot cycle modes, and cannot scroll history.
final class KeyBar: UIInputView {
    /// `Ctrl` latches: tap it, then tap a letter. A modifier you have to hold
    /// is unusable on a touchscreen.
    private(set) var controlLatched = false
    private var controlButton: UIButton?
    private let onKey: (Keys.Special) -> Void
    private let onControlToggle: (Bool) -> Void
    private let onPaste: () -> Void

    init(
        onKey: @escaping (Keys.Special) -> Void,
        onControlToggle: @escaping (Bool) -> Void,
        onPaste: @escaping () -> Void
    ) {
        self.onKey = onKey
        self.onControlToggle = onControlToggle
        self.onPaste = onPaste
        super.init(
            frame: CGRect(x: 0, y: 0, width: 0, height: 44),
            inputViewStyle: .keyboard)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        // Ordered by how often an agent CLI needs them, not by how a
        // sysadmin's terminal app usually lays this out.
        let items: [(String, () -> Void)] = [
            ("esc", { [weak self] in self?.onKey(.escape) }),
            ("paste", { [weak self] in self?.onPaste() }),
            ("ctrl", { [weak self] in self?.toggleControl() }),
            ("tab", { [weak self] in self?.onKey(.tab) }),
            ("⇧tab", { [weak self] in self?.onKey(.backTab) }),
            ("←", { [weak self] in self?.onKey(.left) }),
            ("↓", { [weak self] in self?.onKey(.down) }),
            ("↑", { [weak self] in self?.onKey(.up) }),
            ("→", { [weak self] in self?.onKey(.right) }),
            ("home", { [weak self] in self?.onKey(.home) }),
            ("end", { [weak self] in self?.onKey(.end) }),
            ("pgup", { [weak self] in self?.onKey(.pageUp) }),
            ("pgdn", { [weak self] in self?.onKey(.pageDown) }),
        ]

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 6
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false

        for (title, action) in items {
            var config = UIButton.Configuration.gray()
            config.title = title
            config.baseForegroundColor = .white
            config.cornerStyle = .medium
            let button = UIButton(
                configuration: config,
                primaryAction: UIAction { _ in action() })
            button.titleLabel?.font = .monospacedSystemFont(ofSize: 13, weight: .medium)
            if title == "ctrl" { controlButton = button }
            stack.addArrangedSubview(button)
        }

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    private func toggleControl() {
        controlLatched.toggle()
        var config = controlLatched
            ? UIButton.Configuration.filled()
            : UIButton.Configuration.gray()
        config.title = "ctrl"
        config.baseForegroundColor = .white
        config.cornerStyle = .medium
        controlButton?.configuration = config
        onControlToggle(controlLatched)
    }

    func clearControl() {
        if controlLatched { toggleControl() }
    }
}
