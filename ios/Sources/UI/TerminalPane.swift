import SwiftUI
import UIKit

/// Hosts one terminal, and owns the two things SwiftUI is bad at: getting out
/// of the software keyboard's way, and a find bar that takes the keyboard back
/// afterwards.
///
/// The keyboard part is not cosmetic. Nothing moved before, so the bottom rows
/// of the grid — which is where the prompt and the cursor are — sat underneath
/// the keyboard, and the terminal reported a size that included them. You typed
/// into a line you could not see.
final class TerminalPaneController: UIViewController {
    let session: LiveSession
    private(set) var terminal: TerminalView
    private var bottomInset: NSLayoutConstraint!
    private var findBar: FindBar?
    private var findBottom: NSLayoutConstraint!

    var onOpenURL: ((URL) -> Void)?
    var onNewSession: (() -> Void)?
    var onCloseSession: (() -> Void)?
    var onPickSession: ((Int) -> Void)?

    /// Back to the live bottom, for the button the shell shows while parked in
    /// history.
    func jumpToLatest() {
        session.engine.scrollToBottom()
    }

    init(session: LiveSession, theme: Theme) {
        self.session = session
        self.terminal = TerminalView(engine: session.engine, theme: theme)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = terminal.theme.background.uiColor

        terminal.translatesAutoresizingMaskIntoConstraints = false
        terminal.terminalDelegate = self
        terminal.onScrollStateChanged = { [weak self] back in
            self?.session.scrolledBack = back
        }
        // Both directions: the size the settings sheet remembers, and the size
        // a pinch just chose. Without the write-back, pinching to something
        // comfortable lasted until you switched terminals.
        terminal.fontSize = Settings.shared.fontSize
        terminal.onFontSizeChanged = { size in Settings.shared.fontSize = size }
        view.addSubview(terminal)

        bottomInset = terminal.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            terminal.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            terminal.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            terminal.topAnchor.constraint(equalTo: view.topAnchor),
            bottomInset,
        ])

        // `willChangeFrame` rather than `willShow`: the hardware-keyboard
        // shortcut bar, a floating keyboard being dragged, and Stage Manager
        // resizes all change the frame without ever showing or hiding.
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardChanged(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        session.touch()
        _ = terminal.becomeFirstResponder()
    }

    @objc private func keyboardChanged(_ note: Notification) {
        guard let info = note.userInfo,
            let end = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
            let window = view.window
        else { return }

        // How much of *this* view the keyboard covers, which on an iPad is not
        // the same as the keyboard's height: a split view, Slide Over or a
        // floating keyboard can put it beside the pane rather than under it.
        let keyboard = window.convert(end, to: view)
        let overlap = max(0, view.bounds.maxY - keyboard.minY)

        let duration = info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = info[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7

        bottomInset.constant = -overlap
        findBottom?.constant = -overlap
        UIView.animate(
            withDuration: duration, delay: 0,
            options: UIView.AnimationOptions(rawValue: curve << 16)
        ) {
            self.view.layoutIfNeeded()
        }
    }

    // MARK: - find

    func toggleFind() {
        if findBar != nil {
            closeFind()
        } else {
            openFind()
        }
    }

    private func openFind() {
        let bar = FindBar(theme: terminal.theme)
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.onQuery = { [weak self] text in self?.runSearch(text) }
        bar.onStep = { [weak self] delta in self?.stepSearch(by: delta) }
        bar.onClose = { [weak self] in self?.closeFind() }
        view.addSubview(bar)
        findBottom = bar.bottomAnchor.constraint(
            equalTo: view.bottomAnchor, constant: bottomInset.constant)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            findBottom,
        ])
        findBar = bar
        bar.focus()
    }

    private func closeFind() {
        findBar?.removeFromSuperview()
        findBar = nil
        terminal.searchHits = []
        terminal.currentSearchHit = nil
        hits = []
        hitIndex = 0
        _ = terminal.becomeFirstResponder()
    }

    private var hits: [Term.Match] = []
    private var hitIndex = 0

    private func runSearch(_ needle: String) {
        guard !needle.isEmpty else {
            terminal.searchHits = []
            terminal.currentSearchHit = nil
            hits = []
            findBar?.report(current: 0, total: 0)
            return
        }
        session.engine.search(needle) { [weak self] result in
            guard let self else { return }
            hits = result.matches
            terminal.searchHits = hits
            // The last hit is the newest, and a terminal is read from the
            // bottom: starting at the top would land in whatever scrolled past
            // an hour ago.
            hitIndex = max(0, hits.count - 1)
            findBar?.report(current: hits.isEmpty ? 0 : hitIndex + 1, total: result.total)
            reveal()
        }
    }

    private func stepSearch(by delta: Int) {
        guard !hits.isEmpty else { return }
        hitIndex = (hitIndex + delta + hits.count) % hits.count
        findBar?.report(current: hitIndex + 1, total: hits.count)
        reveal()
    }

    private func reveal() {
        guard hitIndex < hits.count else { return }
        let hit = hits[hitIndex]
        terminal.currentSearchHit = hit
        session.engine.reveal(line: hit.line)
    }
}

extension TerminalPaneController: TerminalViewDelegate {
    func terminalView(_ view: TerminalView, open url: URL) {
        onOpenURL?(url)
    }

    func terminalView(_ view: TerminalView, titleChanged title: String) {
        session.setTitle(title)
    }

    func terminalView(_ view: TerminalView, posted note: Term.Notification) {
        session.attention = note
        Notifier.post(note, session: session.id)
    }

    func terminalViewRangBell(_ view: TerminalView) {
        // A sound would be wrong on a device that is often on a desk next to
        // other people; a tap on the wrist of the hand holding it is not.
        Haptics.bell()
    }

    func terminalViewWantsFind(_ view: TerminalView) {
        toggleFind()
    }

    func terminalViewWantsNewSession(_ view: TerminalView) {
        onNewSession?()
    }

    func terminalViewWantsCloseSession(_ view: TerminalView) {
        onCloseSession?()
    }

    func terminalView(_ view: TerminalView, wantsSessionAt index: Int) {
        onPickSession?(index)
    }
}

/// The bar that appears over the bottom of the terminal for Cmd+F.
private final class FindBar: UIView, UITextFieldDelegate {
    var onQuery: ((String) -> Void)?
    var onStep: ((Int) -> Void)?
    var onClose: (() -> Void)?

    private let field = UITextField()
    private let count = UILabel()

    init(theme: Theme) {
        super.init(frame: .zero)
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
        blur.translatesAutoresizingMaskIntoConstraints = false
        addSubview(blur)

        field.placeholder = "Find in terminal"
        field.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        field.textColor = .white
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .search
        field.delegate = self
        field.addTarget(self, action: #selector(changed), for: .editingChanged)

        count.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        count.textColor = theme.muted.uiColor
        count.setContentHuggingPriority(.required, for: .horizontal)

        func button(_ symbol: String, _ action: UIAction) -> UIButton {
            var config = UIButton.Configuration.plain()
            config.image = UIImage(systemName: symbol)
            config.baseForegroundColor = theme.accent.uiColor
            return UIButton(configuration: config, primaryAction: action)
        }

        let row = UIStackView(arrangedSubviews: [
            field,
            count,
            button("chevron.up", UIAction { [weak self] _ in self?.onStep?(-1) }),
            button("chevron.down", UIAction { [weak self] _ in self?.onStep?(1) }),
            button("xmark", UIAction { [weak self] _ in self?.onClose?() }),
        ])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            row.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func focus() {
        field.becomeFirstResponder()
    }

    func report(current: Int, total: Int) {
        count.text = total == 0 ? "" : "\(current) of \(total)"
    }

    @objc private func changed() {
        onQuery?(field.text ?? "")
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        onStep?(1)
        return false
    }
}

/// SwiftUI's view of one terminal.
struct TerminalPane: UIViewControllerRepresentable {
    let session: LiveSession
    let theme: Theme
    var onOpenURL: (URL) -> Void
    var onNewSession: () -> Void
    var onCloseSession: () -> Void
    var onPickSession: (Int) -> Void

    func makeUIViewController(context: Context) -> TerminalPaneController {
        let controller = TerminalPaneController(session: session, theme: theme)
        controller.onOpenURL = onOpenURL
        controller.onNewSession = onNewSession
        controller.onCloseSession = onCloseSession
        controller.onPickSession = onPickSession
        return controller
    }

    func updateUIViewController(_ controller: TerminalPaneController, context: Context) {
        // Only the closures, which capture fresh state each time SwiftUI
        // rebuilds. Anything heavier here runs on every parent redraw.
        controller.onOpenURL = onOpenURL
        controller.onNewSession = onNewSession
        controller.onCloseSession = onCloseSession
        controller.onPickSession = onPickSession
    }
}
