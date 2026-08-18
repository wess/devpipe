import UIKit

/// Fingers, trackpads and mice.
///
/// The rules come from `Gestures`, which is shared with the web client and can
/// be reasoned about without a touchscreen: a finger scrolls, a long press
/// selects, a tap raises the keyboard or opens a link, and when the program is
/// reading the mouse itself the finger becomes a pointer and all of that gets
/// out of the way.
extension TerminalView: UIGestureRecognizerDelegate {
    func installGestures() {
        // A trackpad's two-finger scroll and a mouse wheel arrive as indirect
        // scrolls on a pan recogniser, which is how the Magic Keyboard gets
        // the behaviour without a second code path. Direct touches are handled
        // raw below, so this recogniser must not swallow them.
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleScroll(_:)))
        pan.allowedScrollTypesMask = .all
        pan.delegate = self
        pan.cancelsTouchesInView = false
        pan.delaysTouchesBegan = false
        pan.delaysTouchesEnded = false
        addGestureRecognizer(pan)

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.delegate = self
        pinch.cancelsTouchesInView = false
        addGestureRecognizer(pinch)

        // Pointer motion with no button down, for programs that asked for it
        // (?1003). Without this a TUI's hover states are dead on an iPad with
        // a trackpad, which is the configuration this app is mostly used in.
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(handleHover(_:)))
        hover.delegate = self
        addGestureRecognizer(hover)

        let menu = UIEditMenuInteraction(delegate: self)
        addInteraction(menu)
        editMenu = menu
    }

    func installPointerInteraction() {
        addInteraction(UIPointerInteraction(delegate: self))
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }

    // MARK: - trackpad and wheel

    @objc private func handleScroll(_ gesture: UIPanGestureRecognizer) {
        // A finger pan has touches; an indirect scroll has none. Direct touches
        // go through `touchesMoved`, which knows about selection and long
        // press, so they must not be handled twice.
        guard gesture.numberOfTouches == 0 else { return }

        switch gesture.state {
        case .began:
            scrollResidual = 0
        case .changed, .ended:
            scrollResidual += gesture.translation(in: self).y
            gesture.setTranslation(.zero, in: self)
            let (rows, remainder) = Gestures.rows(
                forDrag: scrollResidual, cellHeight: cellSize.height)
            guard rows != 0 else { return }
            scrollResidual = remainder
            let (col, row) = cell(at: gesture.location(in: self))
            // Negative because the wheel counts the other way round from a drag:
            // content moving down is history coming into view.
            applyWheel(lines: -rows, col: col, row: row)
        default:
            break
        }
    }

    private func applyWheel(lines: Int, col: Int, row: Int) {
        switch Mouse.wheel(
            modes, lines: lines, col: col, row: row,
            hasScrollback: frame_.scrollbackLength > 0)
        {
        case .send(let bytes):
            engine.send(bytes)
        case .scrollback(let lines):
            engine.scroll(rows: -lines)
        case .ignore:
            break
        }
    }

    // MARK: - pinch to size

    @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        switch gesture.state {
        case .changed:
            // Only act on whole points. A continuous size would re-rasterise
            // every glyph on every frame of the pinch, and the intermediate
            // sizes are not ones anybody wants to read at anyway.
            guard abs(gesture.scale - 1) > 0.15 else { return }
            fontSize += gesture.scale > 1 ? 1 : -1
            gesture.scale = 1
            Haptics.selection()
        default:
            break
        }
    }

    // MARK: - hover

    @objc private func handleHover(_ gesture: UIHoverGestureRecognizer) {
        guard modes.reportMotion else { return }
        let (row, col) = cell(at: gesture.location(in: self))
        guard lastReportedCell?.col != col || lastReportedCell?.row != row else { return }
        lastReportedCell = (col, row)
        if let bytes = Mouse.motion(modes, button: 0, col: col, row: row, held: false) {
            engine.send(bytes)
        }
    }

    // MARK: - touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let point = touch.location(in: self)
        touchStart = point
        touchStartedAt = Date()
        scrollResidual = 0
        let (row, col) = cell(at: point)

        // The program is reading the mouse, so the finger is a pointer and all
        // the touch conventions get out of the way.
        if modes.reportClick {
            gesture = .pointer
            reportedButton = 0
            lastReportedCell = (col, row)
            if let bytes = Mouse.report(modes, button: 0, col: col, row: row, pressed: true) {
                engine.send(bytes)
            }
            return
        }

        gesture = .pending
        // Underline whatever link is under the finger while it is down: a tap
        // target you cannot see is a tap target people do not try.
        engine.link(visibleRow: row, col: col) { [weak self] hit in
            guard let self, gesture == .pending || gesture == .select, let hit else { return }
            touchedLink = (hit.row, hit.startCol, hit.endCol)
            redraw()
        }

        longPressTimer?.invalidate()
        // `.common`, not `Timer.scheduledTimer`.
        //
        // A scheduled timer joins the run loop in the default mode only, and
        // UIKit runs the loop in *tracking* mode for as long as a finger is
        // down — which is precisely and exclusively the situation this timer
        // exists to measure. It fired only when some other recogniser happened
        // to keep the loop in default mode, so the long press worked
        // intermittently and looked like a flaky touchscreen.
        let timer = Timer(timeInterval: Gestures.longPress, repeats: false) { [weak self] _ in
            guard let self, gesture == .pending else { return }
            beginSelecting(at: point)
        }
        RunLoop.main.add(timer, forMode: .common)
        longPressTimer = timer
    }

    private func beginSelecting(at point: CGPoint) {
        gesture = .select
        touchedLink = nil
        let (row, col) = cell(at: point)
        selectionAnchor = (row, col)
        // A long press selects the word under the finger, then the drag
        // extends from there. Landing on a bare caret would mean the gesture
        // appeared to do nothing until the finger moved.
        engine.beginSelection(mode: .word, visibleRow: row, col: col)
        Haptics.tap(.medium)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let point = touch.location(in: self)
        let elapsed = Date().timeIntervalSince(touchStartedAt)
        let previous = gesture
        gesture = Gestures.classify(gesture, from: touchStart, to: point, elapsed: elapsed)

        if gesture != previous, gesture == .scroll {
            longPressTimer?.invalidate()
            touchedLink = nil
            redraw()
        }

        switch gesture {
        case .scroll:
            scrollResidual += point.y - touch.previousLocation(in: self).y
            let (rows, remainder) = Gestures.rows(
                forDrag: scrollResidual, cellHeight: cellSize.height)
            guard rows != 0 else { return }
            scrollResidual = remainder
            // Dragging down reveals what is above, so the content follows the
            // finger rather than the viewport doing.
            engine.scroll(rows: rows)
        case .select:
            let (row, col) = cell(at: point)
            engine.extendSelection(visibleRow: row, col: col)
        case .pointer:
            let (row, col) = cell(at: point)
            guard lastReportedCell?.col != col || lastReportedCell?.row != row else { return }
            lastReportedCell = (col, row)
            if let bytes = Mouse.motion(
                modes, button: reportedButton ?? 0, col: col, row: row, held: true)
            {
                engine.send(bytes)
            }
        case .pending:
            break
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        longPressTimer?.invalidate()
        guard let touch = touches.first else { return finishTouch() }
        let point = touch.location(in: self)
        let elapsed = Date().timeIntervalSince(touchStartedAt)
        let (row, col) = cell(at: point)

        switch gesture {
        case .pointer:
            if let bytes = Mouse.report(
                modes, button: reportedButton ?? 0, col: col, row: row, pressed: false)
            {
                engine.send(bytes)
            }
        case .select:
            // The selection is made; offer to do something with it.
            presentEditMenu(at: point)
        default:
            if Gestures.wasTap(gesture, from: touchStart, to: point, elapsed: elapsed) {
                handleTap(row: row, col: col)
            }
        }
        finishTouch()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        longPressTimer?.invalidate()
        if gesture == .pointer, let button = reportedButton,
            let last = lastReportedCell,
            let bytes = Mouse.report(
                modes, button: button, col: last.col, row: last.row, pressed: false)
        {
            engine.send(bytes)
        }
        finishTouch()
    }

    private func finishTouch() {
        gesture = .pending
        reportedButton = nil
        if touchedLink != nil {
            touchedLink = nil
            redraw()
        }
    }

    /// A tap opens a link if there is one under the finger, and otherwise puts
    /// the keyboard up. Checking the link first means a URL never needs a
    /// different gesture to be useful — which matters because an agent's OAuth
    /// prompt prints one several hundred characters long and asks you to open
    /// it.
    private func handleTap(row: Int, col: Int) {
        if hasSelection {
            engine.clearSelection()
            return
        }
        engine.link(visibleRow: row, col: col) { [weak self] hit in
            guard let self else { return }
            if let hit {
                terminalDelegate?.terminalView(self, open: hit.url)
            } else {
                _ = becomeFirstResponder()
            }
        }
    }
}

// MARK: - the edit menu

extension TerminalView: UIEditMenuInteractionDelegate {
    func presentEditMenu(at point: CGPoint) {
        guard let editMenu else { return }
        editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        menuFor configuration: UIEditMenuConfiguration,
        suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        UIMenu(children: [
            UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                self?.copySelection()
            },
            UIAction(title: "Paste", image: UIImage(systemName: "doc.on.clipboard")) {
                [weak self] _ in
                self?.pasteFromClipboard()
            },
            // The reason selection exists at all on this device: an agent
            // prints a command, and running it should not mean retyping it.
            UIAction(title: "Copy and Run", image: UIImage(systemName: "return")) { [weak self] _ in
                self?.copyAndRun()
            },
        ])
    }

    private func copyAndRun() {
        engine.selectionText { [weak self] text in
            guard let self, let text, !text.isEmpty else { return }
            UIPasteboard.general.string = text
            engine.clearSelection()
            sendToPty(Keys.paste(text, modes: modes))
            sendToPty(Keys.bytes(for: .enter, modes: modes))
        }
    }
}

// MARK: - the pointer itself

extension TerminalView: UIPointerInteractionDelegate {
    func pointerInteraction(
        _ interaction: UIPointerInteraction, styleFor region: UIPointerRegion
    ) -> UIPointerStyle? {
        // A beam the height of one row, which is what a pointer over text is
        // meant to look like and what tells you the terminal takes a selection.
        let beam = UIPointerShape.verticalBeam(length: cellSize.height)
        return UIPointerStyle(shape: beam, constrainedAxes: [])
    }
}
