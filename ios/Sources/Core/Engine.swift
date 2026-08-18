import Foundation
import QuartzCore

/// Told on the main thread, after the fact. Never called from the engine's
/// own queue, so an implementation may touch UIKit freely.
protocol EngineDelegate: AnyObject {
    /// A new frame is ready. Draw when convenient.
    func engineDidPublish(_ engine: Engine)
    /// The terminal wants something from the app: a bell, a notification, a
    /// clipboard write, a new title.
    func engine(_ engine: Engine, observed events: Engine.Observation)
}

/// Owns the emulator, on one queue, for its whole life.
///
/// Everything that touches `Term` happens here. That is not tidiness — the
/// Rust side takes `&mut` on every call, so two threads in it at once is
/// undefined behaviour. The previous arrangement did exactly that: the
/// websocket called `feed` on URLSession's delegate queue while the display
/// link called `takeDamage` and `snapshot` on the main thread, and the
/// resulting corruption surfaced as crashes with stacks pointing nowhere near
/// it.
///
/// Parsing staying off the main thread is the other half of the point. A build
/// that prints ten megabytes arrives as fast as the socket can deliver it, and
/// parsing that where the touches are handled is a stall you can see.
///
/// Nothing here ever makes the main thread wait on the queue. Every question
/// with an answer — the selection, a link under a finger, a search — is asked
/// with a completion, because the one moment you most want to ask is the one
/// where the queue is busiest.
final class Engine {
    /// What the pump saw, batched into one hop to the main thread.
    struct Observation {
        var bell = false
        var title: String?
        var cwd: String?
        var clipboard: String?
        var notification: Term.Notification?
        var commandFinished = false

        var isEmpty: Bool {
            !bell && title == nil && cwd == nil && clipboard == nil
                && notification == nil && !commandFinished
        }
    }

    weak var delegate: EngineDelegate?

    /// Where bytes bound for the pty go: keystrokes, and whatever the emulator
    /// owes in reply. Set by whoever attached a source.
    var onOutbound: ((Data) -> Void)?

    /// The grid changed size and the pty on the other end has to be told.
    ///
    /// Not optional, and not merely cosmetic. A pty that still thinks it is
    /// 100 columns while the emulator is 154 means the shell's model of the
    /// screen and ours disagree about where every line ends — so it declines to
    /// clear a region it believes is already blank, and the tail of whatever
    /// was there before survives underneath the new prompt. It reads as a
    /// rendering bug and is not one.
    var onResize: ((Int, Int) -> Void)?

    private let queue = DispatchQueue(label: "io.wess.devpipe.terminal", qos: .userInteractive)
    private let term: Term
    private let theme: Theme

    /// Bytes waiting to be parsed, filled from whatever thread the socket
    /// happens to use and drained only on the queue.
    private let inbox = Inbox()

    /// Guards `published` alone. Held for a struct copy, never for work.
    private let frameLock = NSLock()
    private var published = TerminalFrame()
    private var generation: UInt64 = 0

    /// Three deep so the engine can build one while the renderer reads
    /// another. Copy-on-write makes a fourth-in-flight case correct rather
    /// than fast, which is the right way round for a safety net.
    private var scratch = [TerminalFrame(), TerminalFrame(), TerminalFrame()]
    private var scratchIndex = 0

    /// A pump is queued; more input should not queue a second one.
    private var pumpScheduled = false
    /// Damage has been taken but not yet drawn.
    ///
    /// Separate from the damage list itself, and that separation is the whole
    /// point: `take_damage` *drains*. Any path that asks the emulator what
    /// changed and then declines to draw has destroyed the only record that
    /// anything did. That bug shipped for about ten minutes here and showed up
    /// as a shell prompt that never appeared after a command finished — the
    /// bytes arrived, the emulator parsed them, the damage was taken by a
    /// publish that bailed on the frame-rate cap, and nothing ever asked again.
    private var dirty = false
    /// A deferred publish is already booked.
    private var publishScheduled = false
    private var lastPublish: CFTimeInterval = 0
    /// Never build frames faster than the display can show them.
    private var minPublishInterval: CFTimeInterval = 1.0 / 120.0

    /// When the program's synchronized-output bracket opened, so one that
    /// opens a bracket and dies cannot freeze the terminal with it.
    private var holdingSince: CFTimeInterval?
    private static let maxHold: CFTimeInterval = 0.1

    init(cols: Int = 80, rows: Int = 24, scrollback: Int = 10_000, theme: Theme = .dark) {
        self.theme = theme
        self.term = Term(cols: cols, rows: rows, scrollback: scrollback)
    }

    /// Cap frame production at what the screen can actually present.
    func setDisplayRefreshRate(_ fps: Int) {
        let clamped = max(30, min(fps, 240))
        queue.async { [self] in minPublishInterval = 1.0 / Double(clamped) }
    }

    // MARK: - input

    /// Bytes off the wire. Cheap and safe from any thread by design: the
    /// socket must never wait on the emulator.
    func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        inbox.append(data)
        schedulePump()
    }

    /// Something the user typed. Goes straight out — echo is the pty's
    /// business, not ours — and pulls the view back to the live bottom first,
    /// because typing while parked in history and seeing nothing happen reads
    /// as a hung terminal.
    func send(_ data: Data) {
        guard !data.isEmpty else { return }
        onOutbound?(data)
        queue.async { [self] in
            guard term.displayOffset != 0 else { return }
            term.scrollToBottom()
            publish(force: true)
        }
    }

    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        queue.async { [self] in
            guard cols != term.cols || rows != term.rows else { return }
            term.resize(cols: cols, rows: rows)
            onResize?(cols, rows)
            publish(force: true)
        }
    }

    /// What the view last measured, so a reconnect can re-assert it: the pty
    /// keeps whatever size it was created with otherwise.
    var size: (cols: Int, rows: Int) {
        let frame = currentFrame
        return (max(frame.cols, 1), max(frame.rows, 1))
    }

    /// Start again from nothing: a different session, or the same one
    /// reattached. Without it the previous session's screen sits underneath
    /// whatever the new one paints.
    func reset() {
        inbox.clear()
        queue.async { [self] in
            term.reset()
            publish(force: true)
        }
    }

    func scroll(rows delta: Int) {
        guard delta != 0 else { return }
        queue.async { [self] in
            term.scroll(delta)
            publish(force: true)
        }
    }

    func scrollToBottom() {
        queue.async { [self] in
            guard term.displayOffset != 0 else { return }
            term.scrollToBottom()
            publish(force: true)
        }
    }

    func reportFocus(_ focused: Bool) {
        queue.async { [self] in
            term.reportFocus(focused)
            flushOwed()
        }
    }

    // MARK: - selection

    func beginSelection(mode: Term.SelectionMode, visibleRow: Int, col: Int) {
        queue.async { [self] in
            term.startSelection(mode, line: term.line(forVisibleRow: visibleRow), col: col)
            publish(force: true)
        }
    }

    func extendSelection(visibleRow: Int, col: Int) {
        queue.async { [self] in
            term.updateSelection(line: term.line(forVisibleRow: visibleRow), col: col)
            publish(force: true)
        }
    }

    func clearSelection() {
        queue.async { [self] in
            guard term.selection != nil else { return }
            term.clearSelection()
            publish(force: true)
        }
    }

    /// The selected text, answered on the main thread.
    func selectionText(_ then: @escaping (String?) -> Void) {
        queue.async { [self] in
            let text = term.selectionText
            DispatchQueue.main.async { then(text) }
        }
    }

    /// The link under a cell, answered on the main thread.
    func link(visibleRow: Int, col: Int, _ then: @escaping (Term.Link?) -> Void) {
        queue.async { [self] in
            let hit = term.link(row: visibleRow, col: col)
            DispatchQueue.main.async { then(hit) }
        }
    }

    // MARK: - search

    struct SearchResult {
        var matches: [Term.Match] = []
        var total = 0
        /// Where the live screen starts in the match line space.
        var scrollbackLength = 0
    }

    func search(
        _ needle: String, caseSensitive: Bool = false, _ then: @escaping (SearchResult) -> Void
    ) {
        queue.async { [self] in
            let found = term.search(needle, caseSensitive: caseSensitive)
            let out = SearchResult(
                matches: found.matches, total: found.total,
                scrollbackLength: term.scrollbackLength)
            DispatchQueue.main.async { then(out) }
        }
    }

    /// Put a global line roughly in the middle of the viewport.
    func reveal(line: Int) {
        queue.async { [self] in
            let sb = term.scrollbackLength
            // A visible row is `line - sb + offset`, and we want it centred.
            let offset = sb - line + term.rows / 2
            term.setDisplayOffset(max(0, min(offset, sb)))
            publish(force: true)
        }
    }

    // MARK: - frames

    /// The newest frame, or nil when the caller has already drawn it.
    func frame(newerThan drawn: UInt64) -> TerminalFrame? {
        frameLock.lock()
        defer { frameLock.unlock() }
        guard published.generation > drawn else { return nil }
        return published
    }

    /// Whatever is current, for a view that has just appeared with nothing on
    /// screen and needs something to paint.
    var currentFrame: TerminalFrame {
        frameLock.lock()
        defer { frameLock.unlock() }
        return published
    }

    /// Modes the key and pointer encoders need, as of the last published
    /// frame. One frame of staleness cannot matter: the modes change in
    /// response to output, and a keystroke encoded against the frame the user
    /// was looking at is the one they meant.
    var keyModes: UInt32 { currentFrame.keyModes }

    // MARK: - the pump

    private func schedulePump() {
        queue.async { [self] in
            guard !pumpScheduled else { return }
            pumpScheduled = true
            pump()
        }
    }

    private func pump() {
        pumpScheduled = false

        // Parse everything waiting, in one go. Feeding in socket-sized pieces
        // costs an FFI call each and gains nothing: the parser is a state
        // machine and does not care where the boundaries fall.
        var fed = false
        inbox.drain { bytes in
            term.feed(bytes)
            fed = true
        }
        guard fed else {
            publish(force: false)
            return
        }

        flushOwed()

        var observed = Observation()
        collect(into: &observed)
        if !observed.isEmpty {
            let seen = observed
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                delegate?.engine(self, observed: seen)
            }
        }

        publish(force: false)

        // More arrived while we were parsing. Go round again rather than
        // waiting for the next append to notice.
        if !inbox.isEmpty { schedulePump() }
    }

    /// Anything the emulator owes the pty — cursor position reports, device
    /// attributes, focus events. A program that asked the terminal a question
    /// and never got an answer hangs, and that includes things a coding agent
    /// shells out to.
    private func flushOwed() {
        guard let reply = term.takeOutput() else { return }
        onOutbound?(reply)
    }

    private func collect(into observed: inout Observation) {
        let events = term.takeEvents()
        guard !events.isEmpty else { return }
        if events.contains(.bell) { observed.bell = true }
        if events.contains(.title) { observed.title = term.title }
        if events.contains(.cwd) { observed.cwd = term.cwd }
        if events.contains(.clipboard) { observed.clipboard = term.clipboardWrite }
        if events.contains(.notification) { observed.notification = term.notification }
        if events.contains(.commandDone) { observed.commandFinished = true }
    }

    /// Build and hand over a frame, if there is one worth handing over.
    ///
    /// Every early return below leaves `dirty` set and books a later attempt.
    /// Dropping out without doing one or the other loses the frame for good.
    private func publish(force: Bool) {
        if case .none = term.takeDamage() {
            if force { dirty = true }
        } else {
            dirty = true
        }
        guard dirty else { return }

        // A program that brackets its repaint (?2026) is mid-update, and
        // showing it now is the difference between a redraw and a flicker.
        // Bounded, because a program that opens a bracket and dies must not
        // take the terminal with it.
        let now = CACurrentMediaTime()
        if term.holdingFrame {
            let since = holdingSince ?? now
            holdingSince = since
            if now - since < Self.maxHold {
                scheduleDeferredPublish(after: Self.maxHold - (now - since))
                return
            }
        } else {
            holdingSince = nil
        }

        // Never outrun the display. Building frames nobody will see is the
        // most expensive way to do nothing.
        let elapsed = now - lastPublish
        if elapsed < minPublishInterval {
            scheduleDeferredPublish(after: minPublishInterval - elapsed)
            return
        }

        dirty = false
        lastPublish = now

        scratchIndex = (scratchIndex + 1) % scratch.count
        build(into: &scratch[scratchIndex])
        generation &+= 1
        scratch[scratchIndex].generation = generation

        frameLock.lock()
        published = scratch[scratchIndex]
        frameLock.unlock()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            delegate?.engineDidPublish(self)
        }
    }

    /// Book one later attempt, no matter how many callers ask.
    private func scheduleDeferredPublish(after delay: CFTimeInterval) {
        guard !publishScheduled else { return }
        publishScheduled = true
        queue.asyncAfter(deadline: .now() + max(delay, 0.001)) { [self] in
            publishScheduled = false
            publish(force: false)
        }
    }

    // MARK: - building a frame

    private func build(into frame: inout TerminalFrame) {
        frame.keyModes = term.keyModes
        let offset = term.displayOffset
        frame.displayOffset = offset
        frame.scrollbackLength = term.scrollbackLength
        frame.fills.removeAll(keepingCapacity: true)
        frame.glyphs.removeAll(keepingCapacity: true)
        frame.highlights.removeAll(keepingCapacity: true)

        let selection = term.selection

        term.withSnapshot { screen, cells in
            let cols = Int(screen.cols)
            let rows = Int(screen.rows)
            frame.cols = cols
            frame.rows = rows
            frame.altScreen = screen.alt_screen != 0
            frame.cursor = CursorState(
                row: Int(screen.cursor_row),
                col: Int(screen.cursor_col),
                visible: screen.cursor_visible != 0,
                style: Self.cursorStyle(screen.cursor_style),
                blinks: screen.cursor_style % 2 == 0)

            for r in 0..<rows {
                appendBackgrounds(row: r, cols: cols, cells: cells, into: &frame.fills)
                appendGlyphs(row: r, cols: cols, cells: cells, into: &frame.glyphs)
                appendDecorations(row: r, cols: cols, cells: cells, into: &frame.fills)
            }
        }

        if let selection {
            appendSelection(selection, offset: offset, into: &frame)
        }
    }

    /// Coalesced runs of shared background. A stretch of default background
    /// collapses to nothing at all, which is most of a typical screen.
    private func appendBackgrounds(
        row r: Int, cols: Int, cells: UnsafeBufferPointer<DpCell>, into fills: inout [FillRun]
    ) {
        let base = r * cols
        var c = 0
        while c < cols {
            let cell = cells[base + c]
            let inverse = CellFlags(rawValue: cell.flags).contains(.inverse)
            let packed = inverse ? cell.fg : cell.bg
            if !inverse && theme.isDefaultBackground(packed) {
                c += 1
                continue
            }
            var end = c + 1
            while end < cols {
                let next = cells[base + end]
                let nextInverse = CellFlags(rawValue: next.flags).contains(.inverse)
                guard nextInverse == inverse, (nextInverse ? next.fg : next.bg) == packed
                else { break }
                end += 1
            }
            fills.append(
                FillRun(
                    col: UInt16(c), row: UInt16(r), width: UInt16(end - c),
                    style: .background,
                    color: theme.resolve(packed, isForeground: inverse)))
            c = end
        }
    }

    private func appendGlyphs(
        row r: Int, cols: Int, cells: UnsafeBufferPointer<DpCell>, into glyphs: inout [GlyphRun]
    ) {
        let base = r * cols
        for c in 0..<cols {
            let cell = cells[base + c]
            // 0 is a wide character's spacer, which carries no glyph: drawing
            // there overstrikes the right half of the character before it. A
            // space has nothing to draw either, and skipping it is most of a
            // typical screen.
            guard cell.ch != 0, cell.ch != 32 else { continue }
            let flags = CellFlags(rawValue: cell.flags)
            guard !flags.contains(.invisible), !flags.contains(.wideSpacer) else { continue }

            let inverse = flags.contains(.inverse)
            var color = theme.resolve(inverse ? cell.bg : cell.fg, isForeground: !inverse)
            if flags.contains(.dim) { color = color.mixed(with: theme.background, 0.45) }

            glyphs.append(
                GlyphRun(
                    col: UInt16(c), row: UInt16(r), scalar: cell.ch, color: color,
                    style: flags.intersection(.fontAffecting).rawValue,
                    cellWidth: flags.contains(.wide) ? 2 : 1))
        }
    }

    /// Underlines and strikethrough, coalesced so they run unbroken across a
    /// span rather than being drawn per cell with seams between them.
    private func appendDecorations(
        row r: Int, cols: Int, cells: UnsafeBufferPointer<DpCell>, into fills: inout [FillRun]
    ) {
        let base = r * cols
        var c = 0
        while c < cols {
            let cell = cells[base + c]
            let flags = CellFlags(rawValue: cell.flags)
            guard let style = Self.decoration(flags) else {
                c += 1
                continue
            }
            let inverse = flags.contains(.inverse)
            let color = theme.resolve(inverse ? cell.bg : cell.fg, isForeground: !inverse)
            let alsoStruck = style != .strikethrough && flags.contains(.strikethrough)

            var end = c + 1
            while end < cols {
                let next = cells[base + end]
                let nextFlags = CellFlags(rawValue: next.flags)
                guard Self.decoration(nextFlags) == style,
                    (nextFlags.contains(.strikethrough) && style != .strikethrough) == alsoStruck
                else { break }
                let nextInverse = nextFlags.contains(.inverse)
                guard theme.resolve(nextInverse ? next.bg : next.fg, isForeground: !nextInverse)
                    == color
                else { break }
                end += 1
            }
            fills.append(
                FillRun(
                    col: UInt16(c), row: UInt16(r), width: UInt16(end - c),
                    style: style, color: color))
            // An underline and a strikethrough can sit on the same span.
            if alsoStruck {
                fills.append(
                    FillRun(
                        col: UInt16(c), row: UInt16(r), width: UInt16(end - c),
                        style: .strikethrough, color: color))
            }
            c = end
        }
    }

    private static func decoration(_ flags: CellFlags) -> FillStyle? {
        if flags.contains(.curlyUnderline) { return .curlyUnderline }
        if flags.contains(.doubleUnderline) { return .doubleUnderline }
        if flags.contains(.dottedUnderline) { return .dottedUnderline }
        if flags.contains(.dashedUnderline) { return .dashedUnderline }
        if flags.contains(.underline) { return .underline }
        if flags.contains(.strikethrough) { return .strikethrough }
        return nil
    }

    /// One fill per visible row the selection covers. The core owns what a
    /// selection *is* — where a word ends, how a soft wrap joins — so all this
    /// has to do is turn its span into rectangles.
    private func appendSelection(_ span: Term.Span, offset: Int, into frame: inout TerminalFrame) {
        guard frame.cols > 0 else { return }
        for row in 0..<frame.rows {
            let line = row - offset
            guard line >= span.startLine, line <= span.endLine else { continue }
            let from = line == span.startLine ? span.startCol : 0
            let to = line == span.endLine ? span.endCol : frame.cols - 1
            guard from < frame.cols, to >= from else { continue }
            let end = min(to, frame.cols - 1)
            frame.highlights.append(
                FillRun(
                    col: UInt16(from), row: UInt16(row), width: UInt16(end - from + 1),
                    style: .selection, color: theme.selection))
        }
    }

    /// The core reports `CursorStyle`'s ordinal, not the DECSCUSR parameter:
    /// 0/1 block, 2/3 underline, 4/5 bar, with the even member of each pair
    /// being the blinking one.
    private static func cursorStyle(_ raw: UInt8) -> FillStyle {
        switch raw {
        case 2, 3: return .cursorUnderline
        case 4, 5: return .cursorBar
        default: return .cursorBlock
        }
    }
}

/// Bytes waiting to be parsed.
///
/// Two buffers that trade places, because the interesting property is not
/// throughput but that the socket never waits: appending is a memcpy into a
/// buffer that keeps its capacity, and the reader takes the whole backlog in
/// one swap rather than element by element. In the steady state neither side
/// allocates.
private final class Inbox {
    private let lock = NSLock()
    private var incoming = [UInt8]()
    private var parsing = [UInt8]()

    var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return incoming.isEmpty
    }

    func append(_ data: Data) {
        lock.lock()
        incoming.append(contentsOf: data)
        lock.unlock()
    }

    func clear() {
        lock.lock()
        incoming.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    /// Hands the whole backlog over once. Only ever called from the engine's
    /// queue, which is what makes `parsing` safe to touch outside the lock.
    func drain(_ body: (UnsafeRawBufferPointer) -> Void) {
        lock.lock()
        guard !incoming.isEmpty else {
            lock.unlock()
            return
        }
        swap(&incoming, &parsing)
        lock.unlock()

        parsing.withUnsafeBytes(body)
        parsing.removeAll(keepingCapacity: true)
    }
}
