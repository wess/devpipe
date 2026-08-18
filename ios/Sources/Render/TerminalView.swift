import MetalKit
import UIKit

protocol TerminalViewDelegate: AnyObject {
    /// A link the user tapped.
    func terminalView(_ view: TerminalView, open url: URL)
    /// The child set its own window title, which is how a running agent
    /// labels its pane.
    func terminalView(_ view: TerminalView, titleChanged title: String)
    /// A program raised OSC 9/777/99 — an agent asking for a human.
    func terminalView(_ view: TerminalView, posted note: Term.Notification)
    /// BEL. The app decides whether that is a haptic, a sound, or nothing.
    func terminalViewRangBell(_ view: TerminalView)

    // Command shortcuts the terminal cannot answer on its own, because they
    // are about which terminal you are looking at rather than what is in it.
    func terminalViewWantsFind(_ view: TerminalView)
    func terminalViewWantsNewSession(_ view: TerminalView)
    func terminalViewWantsCloseSession(_ view: TerminalView)
    func terminalView(_ view: TerminalView, wantsSessionAt index: Int)
}

extension TerminalViewDelegate {
    func terminalView(_ view: TerminalView, open url: URL) {}
    func terminalView(_ view: TerminalView, titleChanged title: String) {}
    func terminalView(_ view: TerminalView, posted note: Term.Notification) {}
    func terminalViewRangBell(_ view: TerminalView) {}
    func terminalViewWantsFind(_ view: TerminalView) {}
    func terminalViewWantsNewSession(_ view: TerminalView) {}
    func terminalViewWantsCloseSession(_ view: TerminalView) {}
    func terminalView(_ view: TerminalView, wantsSessionAt index: Int) {}
}

/// The terminal, drawn with Metal, fed by an `Engine`.
///
/// It draws when the engine says there is something new and at no other time.
/// There is no display link and no timer on an idle terminal — the previous
/// version ran a `CADisplayLink` at the full refresh rate for the life of the
/// app, called into the emulator on every tick to be told nothing had changed,
/// and wrote two performance counters into an `@Published` property while it
/// was there, which re-evaluated the entire SwiftUI tree 120 times a second.
/// That was most of the jank.
final class TerminalView: MTKView {
    weak var terminalDelegate: TerminalViewDelegate?
    let engine: Engine

    private var renderer: TerminalRenderer?
    private var cached = TerminalFrame()
    private var drawnGeneration: UInt64 = 0

    /// Set by the accessory row's latching Ctrl; consumed by the next
    /// character typed.
    var controlLatched = false {
        didSet { keyBar?.setControlLatched(controlLatched) }
    }
    private(set) var keyBar: KeyBar?

    // MARK: - appearance

    var theme: Theme {
        didSet {
            clearColor = Self.clearColor(theme)
            renderer?.setTheme(theme)
            redraw()
        }
    }

    /// Font size in points. Pinch changes it; so does the settings sheet.
    var fontSize: CGFloat = 13 {
        didSet {
            let clamped = min(max(fontSize, 9), 28)
            if clamped != fontSize {
                fontSize = clamped
                return
            }
            guard clamped != oldValue else { return }
            applyFont()
            onFontSizeChanged?(clamped)
        }
    }

    /// So a pinch is remembered rather than lasting until the next terminal.
    var onFontSizeChanged: ((CGFloat) -> Void)?

    // MARK: - pointer and selection state, owned by the gesture extension

    var gesture = Gestures.Kind.pending
    var touchStart = CGPoint.zero
    var touchStartedAt = Date.distantPast
    var scrollResidual: CGFloat = 0
    /// Where the selection began, so a drag can re-anchor it after a scroll.
    var selectionAnchor: (row: Int, col: Int)?
    /// The link under a finger, underlined while it is held.
    var touchedLink: (row: Int, start: Int, end: Int)?
    /// Which mouse button the program thinks is down, for drag reports.
    var reportedButton: Int?
    var lastReportedCell: (col: Int, row: Int)?
    /// Fires when a still finger has been down long enough to be selecting.
    /// A timer rather than a check inside `touchesMoved`, because the whole
    /// point of a long press is that the finger has not moved.
    var longPressTimer: Timer?
    var editMenu: UIEditMenuInteraction?
    /// Whether the last published frame carried a selection. Cheaper than
    /// asking the engine, and never stale by more than a frame.
    var hasSelection: Bool { !cached.highlights.isEmpty }

    /// Told when the viewport leaves or rejoins the live bottom.
    ///
    /// Only on the transition, never per frame. A terminal parked in history is
    /// a state the app has to say something about — new output is arriving
    /// somewhere the reader cannot see it — but it is not something to
    /// re-render SwiftUI for a hundred and twenty times a second while a finger
    /// is moving.
    var onScrollStateChanged: ((Bool) -> Void)?
    private var wasScrolledBack = false

    /// Search results the host asked to have highlighted, in global line
    /// coordinates. Turned into visible rows at draw time.
    var searchHits: [Term.Match] = [] {
        didSet { redraw() }
    }
    var currentSearchHit: Term.Match? {
        didSet { redraw() }
    }

    // MARK: - blink

    private var blinkTimer: Timer?
    private var cursorOn = true

    // MARK: - lifecycle

    init(engine: Engine, theme: Theme = .dark) {
        self.engine = engine
        self.theme = theme
        super.init(frame: .zero, device: MTLCreateSystemDefaultDevice())

        colorPixelFormat = .bgra8Unorm
        framebufferOnly = true
        clearColor = Self.clearColor(theme)
        // Draw on demand. `isPaused` plus `enableSetNeedsDisplay` is what makes
        // an idle terminal cost nothing at all.
        isPaused = true
        enableSetNeedsDisplay = true
        autoResizeDrawable = true
        isOpaque = true
        backgroundColor = theme.background.uiColor
        clipsToBounds = true

        if let device {
            renderer = TerminalRenderer(device: device, pixelFormat: colorPixelFormat, theme: theme)
        }

        let bar = KeyBar()
        bar.onKey = { [weak self] key, modifiers in self?.send(key, modifiers: modifiers) }
        bar.onText = { [weak self] text in self?.insertText(text) }
        bar.onControlToggle = { [weak self] on in self?.controlLatched = on }
        bar.onPaste = { [weak self] in self?.pasteFromClipboard() }
        bar.onDismissKeyboard = { [weak self] in _ = self?.resignFirstResponder() }
        keyBar = bar

        engine.delegate = self
        engine.setDisplayRefreshRate(
            window?.screen.maximumFramesPerSecond ?? UIScreen.main.maximumFramesPerSecond)

        installGestures()
        installPointerInteraction()
    }

    required init(coder: NSCoder) { fatalError("not used") }

    deinit {
        blinkTimer?.invalidate()
    }

    private static func clearColor(_ theme: Theme) -> MTLClearColor {
        let components = theme.background.cgColor.components ?? [0, 0, 0, 1]
        return MTLClearColor(
            red: Double(components[0]), green: Double(components[1]),
            blue: Double(components[2]), alpha: 1)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let window else {
            blinkTimer?.invalidate()
            blinkTimer = nil
            return
        }
        contentScaleFactor = window.screen.scale
        preferredFramesPerSecond = window.screen.maximumFramesPerSecond
        engine.setDisplayRefreshRate(window.screen.maximumFramesPerSecond)
        applyFont()
        // The keyboard should be up as soon as there is a terminal to type
        // into. Anything else means a first tap that only raises a keyboard.
        DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() }
    }

    private func applyFont() {
        guard let renderer else { return }
        renderer.setFont(pointSize: fontSize, scale: contentScaleFactor)
        syncGrid()
        redraw()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        syncGrid()
    }

    /// Match the pty to what the view can actually show. A mismatch here is
    /// what produces wrapped prompts and TUIs drawing off the edge.
    private func syncGrid() {
        guard let renderer, bounds.width > 1, bounds.height > 1 else { return }
        let size = CGSize(
            width: bounds.width * contentScaleFactor,
            height: bounds.height * contentScaleFactor)
        let (cols, rows) = renderer.gridSize(forDrawable: size)
        engine.resize(cols: cols, rows: rows)
    }

    /// Cell size in points, which the gesture code needs to turn a touch into
    /// a row and column.
    var cellSize: CGSize {
        guard let renderer, contentScaleFactor > 0 else { return CGSize(width: 1, height: 1) }
        let m = renderer.metrics
        return CGSize(
            width: CGFloat(m.cellWidth) / contentScaleFactor,
            height: CGFloat(m.cellHeight) / contentScaleFactor)
    }

    /// The cell under a point, clamped to the grid so a drag that leaves the
    /// view still extends the selection to the edge rather than stopping.
    func cell(at point: CGPoint) -> (row: Int, col: Int) {
        let size = cellSize
        guard size.width > 0, size.height > 0 else { return (0, 0) }
        let row = Int(point.y / size.height)
        let col = Int(point.x / size.width)
        return (
            max(0, min(row, max(cached.rows - 1, 0))),
            max(0, min(col, max(cached.cols - 1, 0)))
        )
    }

    var modes: TerminalModes { TerminalModes(raw: cached.keyModes) }
    var frame_: TerminalFrame { cached }

    func redraw() {
        setNeedsDisplay()
    }

    // MARK: - drawing

    override func draw(_ rect: CGRect) {
        guard let renderer else { return }
        if let fresh = engine.frame(newerThan: drawnGeneration) {
            cached = fresh
            drawnGeneration = fresh.generation
            let scrolledBack = fresh.displayOffset > 0
            if scrolledBack != wasScrolledBack {
                wasScrolledBack = scrolledBack
                onScrollStateChanged?(scrolledBack)
            }
        }
        guard !cached.isEmpty else { return }

        var overlay = TerminalRenderer.Overlay()
        overlay.focused = isFirstResponder
        overlay.cursorOn = cursorOn
        overlay.searchHits = visibleSearchHits()
        if let link = touchedLink, link.row < cached.rows {
            overlay.touchedLink = FillRun(
                col: UInt16(link.start), row: UInt16(link.row),
                width: UInt16(max(1, link.end - link.start + 1)),
                style: .underline, color: theme.accent)
        }
        renderer.draw(cached, in: self, overlay: overlay)
    }

    /// Search hits are in the global line space; the viewport is not.
    private func visibleSearchHits() -> [FillRun] {
        guard !searchHits.isEmpty, cached.rows > 0 else { return [] }
        let base = cached.scrollbackLength - cached.displayOffset
        var out: [FillRun] = []
        out.reserveCapacity(min(searchHits.count, cached.rows * 2))
        for hit in searchHits {
            let row = hit.line - base
            guard row >= 0, row < cached.rows, hit.startCol < cached.cols else { continue }
            let end = min(hit.endCol, cached.cols - 1)
            guard end >= hit.startCol else { continue }
            let isCurrent = hit == currentSearchHit
            out.append(
                FillRun(
                    col: UInt16(hit.startCol), row: UInt16(row),
                    width: UInt16(end - hit.startCol + 1),
                    style: isCurrent ? .searchHitCurrent : .searchHit,
                    color: isCurrent ? theme.warning : theme.warning.mixed(with: theme.background, 0.55)))
        }
        return out
    }

    // MARK: - focus

    override var canBecomeFirstResponder: Bool { true }

    @discardableResult
    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            engine.reportFocus(true)
            startBlinking()
            redraw()
        }
        return became
    }

    @discardableResult
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            engine.reportFocus(false)
            stopBlinking()
            redraw()
        }
        return resigned
    }

    private func startBlinking() {
        stopBlinking()
        cursorOn = true
        // Only while the terminal has the keyboard. A cursor blinking in a
        // pane nobody is typing into is movement in the corner of the eye and
        // nothing else — and on a battery it is a wakeup every half second for
        // the life of the app.
        // `.common` for the same reason the long-press timer needs it: a
        // scheduled timer runs in the default mode only, so the cursor would
        // freeze mid-blink for as long as a finger was on the screen.
        let timer = Timer(timeInterval: 0.53, repeats: true) { [weak self] _ in
            guard let self, cached.cursor.blinks else { return }
            cursorOn.toggle()
            redraw()
        }
        RunLoop.main.add(timer, forMode: .common)
        blinkTimer = timer
    }

    private func stopBlinking() {
        blinkTimer?.invalidate()
        blinkTimer = nil
        cursorOn = true
    }
}

// MARK: - engine

extension TerminalView: EngineDelegate {
    func engineDidPublish(_ engine: Engine) {
        redraw()
    }

    func engine(_ engine: Engine, observed events: Engine.Observation) {
        if events.bell { terminalDelegate?.terminalViewRangBell(self) }
        if let title = events.title, !title.isEmpty {
            terminalDelegate?.terminalView(self, titleChanged: title)
        }
        if let note = events.notification {
            terminalDelegate?.terminalView(self, posted: note)
        }
        // OSC 52: the program asked for something to be on the clipboard, which
        // is how `yank` in a remote editor reaches the tablet's own paste menu.
        if let clipboard = events.clipboard, !clipboard.isEmpty {
            UIPasteboard.general.string = clipboard
        }
    }
}
