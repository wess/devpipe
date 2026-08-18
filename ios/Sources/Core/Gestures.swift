import CoreGraphics
import Foundation

/// Turning finger gestures into terminal actions.
///
/// A mouse and a finger want opposite defaults. Dragging with a mouse selects
/// text, because there is a wheel for scrolling; dragging with a finger
/// scrolls, because there is not, and a touchscreen that selects on every drag
/// is one where history cannot be reached at all. Selection is still needed —
/// copying a URL out of an agent's OAuth prompt is the whole reason links
/// became tappable — so it moves to long press, which is where every phone
/// puts it.
///
/// Pure, and separate from UIKit, so the arithmetic that decides "this was a
/// tap, that was a scroll" can be checked without a touchscreen to check it on.
/// The same rules as the web client's `touch.ts`, for the same reason.
enum Gestures {
    /// What a finger is currently doing. Decided once, then held.
    enum Kind: Equatable {
        /// Still inside the slop radius and under the long-press delay.
        case pending
        /// Moving through scrollback.
        case scroll
        /// Extending a selection that a long press began.
        case select
        /// The program is reading the mouse, so the finger is a pointer.
        case pointer
    }

    /// How far a finger may wander and still count as a tap rather than a drag.
    ///
    /// Ten points rather than a couple: a finger resting on glass moves several
    /// points without its owner intending anything, and a tap read as a
    /// one-point scroll leaves the keyboard closed with no indication why.
    static let slop: CGFloat = 10

    /// How long a finger must stay still before it is selecting rather than
    /// waiting. Matched to the platform convention rather than chosen — this is
    /// roughly what iOS and Android both use for their own text selection, and
    /// a terminal that disagrees feels broken in a way nobody can name.
    static let longPress: TimeInterval = 0.5

    /// What a moved finger means, given where it started and what it is already
    /// doing.
    ///
    /// A gesture that has committed never changes its mind: a long press that
    /// became a selection stays one even when the finger later travels, or
    /// dragging to extend past a few characters would turn into a scroll and
    /// lose it.
    static func classify(
        _ current: Kind, from start: CGPoint, to point: CGPoint, elapsed: TimeInterval
    ) -> Kind {
        guard current == .pending else { return current }
        let moved = hypot(point.x - start.x, point.y - start.y)
        if moved > slop { return .scroll }
        if elapsed >= longPress { return .select }
        return .pending
    }

    /// Whether a finger that has lifted was a tap.
    ///
    /// A tap raises the software keyboard, which is the single most important
    /// thing a touch terminal has to get right: without it there is no way to
    /// type at all.
    static func wasTap(
        _ kind: Kind, from start: CGPoint, to point: CGPoint, elapsed: TimeInterval
    ) -> Bool {
        kind == .pending && elapsed < longPress
            && hypot(point.x - start.x, point.y - start.y) <= slop
    }

    /// Whole rows to scroll for a drag, and the pixels left over.
    ///
    /// The remainder is returned rather than dropped so the caller can carry it
    /// into the next move. Without that a slow drag scrolls nothing at all:
    /// each event moves a few points, every one rounds to zero rows, and the
    /// content sits still under a finger that is plainly moving.
    ///
    /// Positive `dy` is a finger moving down, which drags the content down,
    /// which means going *back* through history — the direction the page moves,
    /// not the direction the viewport does.
    static func rows(forDrag dy: CGFloat, cellHeight: CGFloat) -> (rows: Int, remainder: CGFloat) {
        guard cellHeight > 0 else { return (0, 0) }
        let rows = Int((dy / cellHeight).rounded(.towardZero))
        return (rows, dy - CGFloat(rows) * cellHeight)
    }
}
