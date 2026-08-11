import CoreText
import UIKit

/// CoreText grid renderer.
///
/// Two things keep this fast enough to be worth measuring. Rows are cached as
/// built `CTLine`s and only rebuilt when the core reports that row dirty —
/// an idle screen costs a blit. And cells are coalesced into runs of shared
/// attributes, so a row of plain text is one `CTLine`, not eighty.
final class TerminalUIView: UIView {
    var term: Term?

    /// Set by the harness to report frame cost; the whole point of Spike 0.
    var onFrameCost: ((Double, Double) -> Void)?

    /// Keystrokes, already encoded as pty bytes.
    var onInput: ((Data) -> Void)?

    /// A tapped link. The login flow is the reason this exists.
    var onOpenURL: ((URL) -> Void)?

    private var fonts: (regular: CTFont, bold: CTFont, italic: CTFont, boldItalic: CTFont)!
    private(set) var cellSize: CGSize = .zero
    private var ascent: CGFloat = 0

    private struct Run {
        let line: CTLine
        let x: CGFloat
    }
    private struct RowRender {
        var runs: [Run] = []
        var backgrounds: [(CGColor, CGRect)] = []
        var decorations: [(CGColor, CGRect)] = []
    }
    private var rowCache: [RowRender?] = []

    private var cursor: (row: Int, col: Int, visible: Bool) = (0, 0, false)
    private var lastRebuildMs: Double = 0

    /// Set by the accessory row's latching Ctrl; consumed by the next
    /// character typed.
    var controlLatched = false
    private var keyBar: KeyBar?

    init(fontSize: CGFloat) {
        super.init(frame: .zero)
        backgroundColor = UIColor(cgColor: Palette.background)
        isOpaque = true
        setFontSize(fontSize)

        let bar = KeyBar(
            onKey: { [weak self] key in self?.send(key) },
            onControlToggle: { [weak self] on in self?.controlLatched = on },
            onPaste: { [weak self] in self?.pasteFromClipboard() })
        keyBar = bar

        addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(handleTap(_:))))

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        // A trackpad's two-finger scroll and a mouse wheel arrive as indirect
        // scrolls on this same recognizer, so the Magic Keyboard gets the
        // behaviour without a second code path.
        pan.allowedScrollTypesMask = .all
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Sub-row remainder of a drag. Dropping it would make a slow pan move
    /// nothing at all.
    private var panResidual: CGFloat = 0

    /// Drag the view through history: the content follows the finger, so
    /// dragging down reveals what is above.
    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard let term, cellSize.height > 0, term.scrollbackLength > 0 else { return }
        switch gesture.state {
        case .began:
            panResidual = 0
        case .changed, .ended:
            panResidual += gesture.translation(in: self).y
            gesture.setTranslation(.zero, in: self)
            let rows = Int(panResidual / cellSize.height)
            guard rows != 0 else { return }
            panResidual -= CGFloat(rows) * cellSize.height
            term.scroll(rows)
            // Scrolling shifts every row, so the core reports full damage and
            // the frame loop rebuilds; this only asks for the paint.
            setNeedsDisplay()
        default:
            break
        }
    }

    /// Everything typed goes out through here so it can pull the view back to
    /// the live bottom first. Sending a keystroke while parked in history and
    /// seeing nothing happen reads as a hung terminal.
    func sendToPty(_ data: Data) {
        term?.scrollToBottom()
        onInput?(data)
    }

    /// A tap opens a link if there is one under the finger, and otherwise
    /// puts the keyboard up. Checking the link first means a URL never needs
    /// a different gesture to be useful.
    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard let term, cellSize.width > 0, cellSize.height > 0 else {
            becomeFirstResponder()
            return
        }
        let p = gesture.location(in: self)
        let row = Int(p.y / cellSize.height)
        let col = Int(p.x / cellSize.width)
        if let link = term.link(row: row, col: col) {
            onOpenURL?(link.url)
            return
        }
        becomeFirstResponder()
    }

    /// Column span of the link under the finger, so it can be underlined
    /// while the finger is down — a tap target you cannot see is a tap target
    /// people do not try.
    private var hotLink: (row: Int, start: Int, end: Int)?

    // Both of these must live on the class: Swift will not let an extension
    // override a superclass member.
    override var canBecomeFirstResponder: Bool { true }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key else { continue }
            if let data = Keys.fromPress(key, modes: keyModes) {
                sendToPty(data)
                handled = true
            }
        }
        // Unhandled presses must fall through, or plain typing on a hardware
        // keyboard stops reaching `insertText`.
        if !handled { super.pressesBegan(presses, with: event) }
    }

    override var inputAccessoryView: UIView? { keyBar }

    /// The OAuth step ends by asking for a code that is, by construction, on
    /// the clipboard — the browser put it there. Bracketed so a shell treats
    /// it as pasted text rather than typing.
    func pasteFromClipboard() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        sendToPty(Keys.paste(text, modes: keyModes))
    }

    /// Consumes a latched Ctrl if one is pending. Lives here rather than in
    /// the input extension because the latch is view state.
    func applyLatchedControl(_ text: String) -> Data? {
        guard controlLatched, let ch = text.first else { return nil }
        keyBar?.clearControl()
        controlLatched = false
        return Keys.control(ch)
    }

    func setFontSize(_ size: CGFloat) {
        // SF Mono via the system's monospace face: every cell advances the same
        // width, which is what lets the renderer place runs by column index
        // instead of measuring.
        func make(_ traits: UIFontDescriptor.SymbolicTraits) -> CTFont {
            let base = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
            let d = traits.isEmpty ? base.fontDescriptor
                : (base.fontDescriptor.withSymbolicTraits(traits) ?? base.fontDescriptor)
            return CTFontCreateWithFontDescriptor(d as CTFontDescriptor, size, nil)
        }
        fonts = (make([]), make(.traitBold), make(.traitItalic), make([.traitBold, .traitItalic]))

        var glyph = CGGlyph(0)
        var ch = UniChar(77)  // "M"
        CTFontGetGlyphsForCharacters(fonts.regular, &ch, &glyph, 1)
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(fonts.regular, .horizontal, &glyph, &advance, 1)

        ascent = CTFontGetAscent(fonts.regular)
        let lineHeight = (ascent + CTFontGetDescent(fonts.regular) + CTFontGetLeading(fonts.regular))
            .rounded(.up)
        cellSize = CGSize(width: advance.width.rounded(.up), height: lineHeight)
    }

    /// Grid size for the current bounds. The caller resizes the pty to match;
    /// a mismatch here is what produces the classic wrapped-prompt garbage.
    func gridSize() -> (cols: Int, rows: Int) {
        guard cellSize.width > 0, cellSize.height > 0 else { return (80, 24) }
        return (
            max(Int(bounds.width / cellSize.width), 1),
            max(Int(bounds.height / cellSize.height), 1)
        )
    }

    /// Pull damage from the core and mark only those rows for rebuild.
    func refresh() {
        guard let term else { return }
        switch term.takeDamage() {
        case .none:
            return
        case .full:
            rowCache = Array(repeating: nil, count: term.rows)
        case .rows(let dirty):
            if rowCache.count != term.rows {
                rowCache = Array(repeating: nil, count: term.rows)
            } else {
                for r in dirty where Int(r) < rowCache.count { rowCache[Int(r)] = nil }
            }
        }
        setNeedsDisplay()
    }

    func invalidateAll() {
        rowCache = []
        setNeedsDisplay()
    }

    private func font(for flags: CellFlags) -> CTFont {
        switch (flags.contains(.bold), flags.contains(.italic)) {
        case (true, true): return fonts.boldItalic
        case (true, false): return fonts.bold
        case (false, true): return fonts.italic
        case (false, false): return fonts.regular
        }
    }

    /// Build one row's draw list: coalesce neighbouring cells that share
    /// attributes into a single `CTLine`, and neighbouring backgrounds into a
    /// single fill.
    private func buildRow(_ r: Int, cells: UnsafeBufferPointer<DpCell>, cols: Int) -> RowRender {
        var out = RowRender()
        let y = CGFloat(r) * cellSize.height
        let base = r * cols

        var col = 0
        while col < cols {
            let cell = cells[base + col]
            var flags = CellFlags(rawValue: cell.flags)
            var fgPacked = cell.fg
            var bgPacked = cell.bg
            if flags.contains(.inverse) { swap(&fgPacked, &bgPacked) }

            // Background run: only the packed value matters, so a long stretch
            // of default background collapses to nothing at all.
            if !(Palette.isDefaultBackground(bgPacked) && !flags.contains(.inverse)) {
                var end = col
                while end < cols {
                    let c2 = cells[base + end]
                    let f2 = CellFlags(rawValue: c2.flags)
                    let bg2 = f2.contains(.inverse) ? c2.fg : c2.bg
                    if bg2 != bgPacked { break }
                    end += 1
                }
                out.backgrounds.append((
                    Palette.resolve(bgPacked, isForeground: flags.contains(.inverse)),
                    CGRect(
                        x: CGFloat(col) * cellSize.width, y: y,
                        width: CGFloat(end - col) * cellSize.width, height: cellSize.height)
                ))
            }

            // Text run: same fg and same font-affecting flags.
            var text = ""
            let runStart = col
            let styleKey = flags.intersection([.bold, .italic])
            while col < cols {
                let c2 = cells[base + col]
                let f2 = CellFlags(rawValue: c2.flags)
                var fg2 = c2.fg
                if f2.contains(.inverse) { fg2 = c2.bg }
                if fg2 != fgPacked || f2.intersection([.bold, .italic]) != styleKey { break }
                if f2.contains(.invisible) || c2.ch == 0 {
                    // A wide char's spacer carries no glyph; emitting anything
                    // here would shove the rest of the row one column right.
                    if c2.ch != 0 { text += " " }
                } else if let scalar = Unicode.Scalar(c2.ch) {
                    text.unicodeScalars.append(scalar)
                }
                flags = f2
                col += 1
            }

            if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                let color = Palette.resolve(fgPacked, isForeground: true)
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: font(for: styleKey),
                    .foregroundColor: color,
                ]
                let line = CTLineCreateWithAttributedString(
                    NSAttributedString(string: text, attributes: attrs))
                out.runs.append(Run(line: line, x: CGFloat(runStart) * cellSize.width))
            }

            // Underline and strikethrough are drawn as rects rather than font
            // attributes: terminals want them cell-aligned and unbroken across
            // a run, which the text attribute does not guarantee.
            let width = CGFloat(col - runStart) * cellSize.width
            let x = CGFloat(runStart) * cellSize.width
            let fg = Palette.resolve(fgPacked, isForeground: true)
            if !flags.intersection(.anyUnderline).isEmpty {
                out.decorations.append((
                    fg, CGRect(x: x, y: y + ascent + 1, width: width, height: 1)))
            }
            if flags.contains(.strikethrough) {
                out.decorations.append((
                    fg, CGRect(x: x, y: y + ascent * 0.6, width: width, height: 1)))
            }
            if col == runStart { col += 1 }  // never stall on a zero-width run
        }
        return out
    }

    /// Highlight the link under a touch while it is held.
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        guard let touch = touches.first, let term,
              cellSize.width > 0, cellSize.height > 0 else { return }
        let p = touch.location(in: self)
        let row = Int(p.y / cellSize.height)
        let col = Int(p.x / cellSize.width)
        if let link = term.link(row: row, col: col) {
            hotLink = (link.row, link.startCol, link.endCol)
            setNeedsDisplay()
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        if hotLink != nil { hotLink = nil; setNeedsDisplay() }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        if hotLink != nil { hotLink = nil; setNeedsDisplay() }
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext(), let term else { return }
        let drawStart = CFAbsoluteTimeGetCurrent()

        ctx.setFillColor(Palette.background)
        ctx.fill(rect)

        let rebuildStart = CFAbsoluteTimeGetCurrent()
        term.withSnapshot { screen, cells in
            let cols = Int(screen.cols)
            let rows = Int(screen.rows)
            if rowCache.count != rows { rowCache = Array(repeating: nil, count: rows) }
            for r in 0..<rows where rowCache[r] == nil {
                rowCache[r] = buildRow(r, cells: cells, cols: cols)
            }
            cursor = (Int(screen.cursor_row), Int(screen.cursor_col), screen.cursor_visible != 0)
        }
        lastRebuildMs = msSince(rebuildStart)

        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        for (r, row) in rowCache.enumerated() {
            guard let row else { continue }
            let y = CGFloat(r) * cellSize.height
            guard y < rect.maxY + cellSize.height, y + cellSize.height > rect.minY - cellSize.height
            else { continue }

            for (color, rect) in row.backgrounds {
                ctx.setFillColor(color)
                ctx.fill(rect)
            }
            for run in row.runs {
                ctx.textPosition = CGPoint(x: run.x, y: y + ascent)
                CTLineDraw(run.line, ctx)
            }
            for (color, rect) in row.decorations {
                ctx.setFillColor(color)
                ctx.fill(rect)
            }
        }

        if let hot = hotLink, hot.row < term.rows {
            ctx.setFillColor(Palette.cursor)
            ctx.fill(CGRect(
                x: CGFloat(hot.start) * cellSize.width,
                y: CGFloat(hot.row) * cellSize.height + ascent + 2,
                width: CGFloat(hot.end - hot.start + 1) * cellSize.width,
                height: 1.5))
        }

        // The snapshot reports the cursor in live-grid coordinates whatever the
        // display offset is, so while scrolled back its row is a history line
        // the cursor has nothing to do with; the block would land on an
        // unrelated character.
        if term.atBottom, cursor.visible, cursor.row < term.rows, cursor.col < term.cols {
            ctx.setFillColor(Palette.cursor)
            ctx.fill(CGRect(
                x: CGFloat(cursor.col) * cellSize.width,
                y: CGFloat(cursor.row) * cellSize.height,
                width: cellSize.width, height: cellSize.height))
        }

        drawScrollMark(ctx, term: term)

        onFrameCost?(lastRebuildMs, msSince(drawStart))
    }

    /// A thumb on the trailing edge while the view is back in history: where
    /// you are, and how much is above and below. Same shape and same reason as
    /// the web renderer's, so the two clients read alike.
    private func drawScrollMark(_ ctx: CGContext, term: Term) {
        let offset = term.displayOffset
        guard offset > 0 else { return }
        let total = CGFloat(term.scrollbackLength + term.rows)
        let rows = CGFloat(term.rows)
        guard total > rows else { return }

        let height = bounds.height
        let thumb = max(24, (rows / total) * height)
        let top = (CGFloat(term.scrollbackLength - offset) / total) * (height - thumb)
        ctx.setFillColor(Palette.cursor.copy(alpha: 0.5) ?? Palette.cursor)
        ctx.fill(CGRect(x: bounds.width - 3, y: top, width: 2, height: thumb))
    }
}

private func msSince(_ start: CFAbsoluteTime) -> Double {
    (CFAbsoluteTimeGetCurrent() - start) * 1000
}
