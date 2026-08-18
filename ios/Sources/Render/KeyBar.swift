import UIKit

/// The row above the software keyboard.
///
/// iOS gives an iPad terminal no Esc, no Ctrl, no Alt and no arrows, so
/// without this a coding agent's TUI cannot be interrupted, cannot cycle
/// permission modes, and cannot scroll its own history. It is not a
/// convenience — it is the difference between the app working and not.
///
/// Ordered by how often an agent CLI needs a key, not by how a sysadmin's
/// terminal app usually lays this out, and scrollable because there are more
/// useful keys than fit on a phone-width pane in Stage Manager.
final class KeyBar: UIInputView {
    var onKey: ((Keys.Special, Keys.Modifiers) -> Void)?
    var onText: ((String) -> Void)?
    var onControlToggle: ((Bool) -> Void)?
    var onPaste: (() -> Void)?
    var onDismissKeyboard: (() -> Void)?

    /// Ctrl and Alt latch: tap one, then tap a key. A modifier you have to
    /// hold is unusable on a touchscreen, and holding one on a hardware
    /// keyboard already works without any of this.
    private var controlLatched = false
    private var altLatched = false
    private var controlButton: UIButton?
    private var altButton: UIButton?

    private let scroller = UIScrollView()
    private let row = UIStackView()

    private enum Item {
        case special(String, Keys.Special)
        case text(String, String)
        case control
        case alt
        case paste
        case dismiss
    }

    private static let items: [Item] = [
        .special("esc", .escape),
        .control,
        .alt,
        .special("tab", .tab),
        .special("⇧tab", .backTab),
        .paste,
        .special("←", .left),
        .special("↓", .down),
        .special("↑", .up),
        .special("→", .right),
        // The punctuation an iOS keyboard buries two layers deep, which is
        // most of what a shell command is made of.
        .text("/", "/"),
        .text("-", "-"),
        .text("_", "_"),
        .text("|", "|"),
        .text("~", "~"),
        .text("$", "$"),
        .text("*", "*"),
        .text("\"", "\""),
        .text("'", "'"),
        .special("home", .home),
        .special("end", .end),
        .special("pgup", .pageUp),
        .special("pgdn", .pageDown),
        .dismiss,
    ]

    init(theme: Theme = .dark) {
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 48), inputViewStyle: .keyboard)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 48)
    }

    private func build() {
        row.axis = .horizontal
        row.spacing = 6
        row.alignment = .fill
        row.distribution = .fill
        row.translatesAutoresizingMaskIntoConstraints = false

        scroller.showsHorizontalScrollIndicator = false
        scroller.alwaysBounceHorizontal = true
        scroller.contentInsetAdjustmentBehavior = .never
        scroller.translatesAutoresizingMaskIntoConstraints = false
        scroller.addSubview(row)
        addSubview(scroller)

        for item in Self.items { row.addArrangedSubview(button(for: item)) }

        // The row must be allowed to be wider than the bar — that is the whole
        // point of the scroll view. Without pinning it to the *content* guide
        // and letting every button refuse to shrink, autolayout resolves the
        // ambiguity by squeezing the row into the visible width, and every
        // label wraps: `ctrl` becomes two lines reading "ct" and "rl".
        NSLayoutConstraint.activate([
            scroller.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroller.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroller.topAnchor.constraint(equalTo: topAnchor),
            scroller.bottomAnchor.constraint(equalTo: bottomAnchor),

            row.leadingAnchor.constraint(
                equalTo: scroller.contentLayoutGuide.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(
                equalTo: scroller.contentLayoutGuide.trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor, constant: 6),
            row.bottomAnchor.constraint(
                equalTo: scroller.contentLayoutGuide.bottomAnchor, constant: -6),
            row.heightAnchor.constraint(
                equalTo: scroller.frameLayoutGuide.heightAnchor, constant: -12),
        ])

        // Fill the bar when the keys happen to fit, which on a full-width iPad
        // they nearly do; break first so a narrow pane scrolls instead.
        let fill = row.widthAnchor.constraint(
            greaterThanOrEqualTo: scroller.frameLayoutGuide.widthAnchor, constant: -16)
        fill.priority = .defaultLow
        fill.isActive = true
    }

    private func button(for item: Item) -> UIButton {
        let button = UIButton(type: .system)
        var config = UIButton.Configuration.gray()
        config.cornerStyle = .medium
        config.baseForegroundColor = .white
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12)

        switch item {
        case .special(let title, let key):
            config.title = title
            button.addAction(
                UIAction { [weak self] _ in
                    guard let self else { return }
                    onKey?(key, Keys.Modifiers(alt: consumeAlt()))
                    tick()
                }, for: .touchUpInside)
        case .text(let title, let text):
            config.title = title
            button.addAction(
                UIAction { [weak self] _ in
                    guard let self else { return }
                    if consumeAlt() {
                        onText?("\u{1b}" + text)
                    } else {
                        onText?(text)
                    }
                    tick()
                }, for: .touchUpInside)
        case .control:
            config.title = "ctrl"
            controlButton = button
            button.addAction(
                UIAction { [weak self] _ in self?.toggleControl() }, for: .touchUpInside)
        case .alt:
            config.title = "alt"
            altButton = button
            button.addAction(UIAction { [weak self] _ in self?.toggleAlt() }, for: .touchUpInside)
        case .paste:
            config.image = UIImage(systemName: "doc.on.clipboard")
            button.addAction(
                UIAction { [weak self] _ in
                    self?.onPaste?()
                    self?.tick()
                }, for: .touchUpInside)
        case .dismiss:
            config.image = UIImage(systemName: "keyboard.chevron.compact.down")
            button.addAction(
                UIAction { [weak self] _ in self?.onDismissKeyboard?() }, for: .touchUpInside)
        }

        config.titleLineBreakMode = .byClipping
        button.configuration = config
        button.titleLabel?.font = .monospacedSystemFont(ofSize: 14, weight: .medium)
        button.titleLabel?.numberOfLines = 1
        button.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        // Apple's own minimum for something a finger has to hit.
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        return button
    }

    // MARK: - latches

    func setControlLatched(_ on: Bool) {
        guard on != controlLatched else { return }
        controlLatched = on
        paint(controlButton, title: "ctrl", latched: on)
    }

    private func toggleControl() {
        controlLatched.toggle()
        paint(controlButton, title: "ctrl", latched: controlLatched)
        onControlToggle?(controlLatched)
        tick()
    }

    private func toggleAlt() {
        altLatched.toggle()
        paint(altButton, title: "alt", latched: altLatched)
        tick()
    }

    /// Alt is one-shot, like Ctrl: reading it clears it.
    private func consumeAlt() -> Bool {
        guard altLatched else { return false }
        altLatched = false
        paint(altButton, title: "alt", latched: false)
        return true
    }

    private func paint(_ button: UIButton?, title: String, latched: Bool) {
        guard let button else { return }
        var config = latched ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
        config.title = title
        config.cornerStyle = .medium
        config.baseForegroundColor = .white
        config.baseBackgroundColor = latched ? Theme.dark.accent.uiColor : nil
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12)
        button.configuration = config
    }

    /// A key with no visible effect on screen — Esc into a program that
    /// ignores it, a latch — still has to feel like it registered.
    private func tick() {
        Haptics.selection()
    }
}
