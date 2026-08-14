/**
 * Turning finger gestures into terminal actions.
 *
 * A mouse and a finger want opposite defaults. Dragging with a mouse selects
 * text, because there is a wheel for scrolling; dragging with a finger scrolls,
 * because there is not, and a touchscreen that selects on every drag is one
 * where history cannot be reached at all. Selection is still needed — copying a
 * URL out of an agent's OAuth prompt is the whole reason links became clickable
 * — so it moves to long-press, which is where every phone puts it.
 *
 * Pure, and separate from the DOM, so the arithmetic that decides "this was a
 * tap, that was a scroll" can be checked without a browser and without a
 * touchscreen to check it on.
 */

/** What a finger is currently doing. Decided once, then held for the gesture. */
export type Gesture =
  /** Nothing yet: still inside the slop radius and under the long-press delay. */
  | { kind: "pending" }
  /** Moving through scrollback. */
  | { kind: "scroll" }
  /** Extending a selection that a long press began. */
  | { kind: "select" }

/** A finger down, in pixels relative to the canvas. */
export type Touch = { x: number; y: number; at: number }

/**
 * How far a finger may wander and still count as a tap rather than a drag.
 *
 * Ten pixels rather than a couple: a finger resting on glass moves several
 * pixels without its owner intending anything, and a tap that is read as a
 * one-pixel scroll leaves the keyboard closed with no indication why.
 */
export const SLOP = 10

/**
 * How long a finger must stay still before it is selecting rather than waiting.
 *
 * Matched to the platform convention rather than chosen: this is roughly what
 * iOS and Android both use for their own text selection, and a terminal that
 * disagrees feels broken in a way nobody can name.
 */
export const LONG_PRESS_MS = 500

/**
 * What a moved finger means, given where it started and what it is already
 * doing.
 *
 * `elapsed` is milliseconds since it went down. A gesture that has already
 * committed never changes its mind: a long press that became a selection stays
 * a selection even when the finger later travels, or dragging to extend a
 * selection past a few characters would turn into a scroll and lose it.
 */
export const classify = (current: Gesture, start: Touch, x: number, y: number, elapsed: number): Gesture => {
  if (current.kind !== "pending") return current
  const moved = Math.hypot(x - start.x, y - start.y)
  if (moved > SLOP) return { kind: "scroll" }
  if (elapsed >= LONG_PRESS_MS) return { kind: "select" }
  return { kind: "pending" }
}

/**
 * Whether a finger that has lifted was a tap.
 *
 * A tap focuses the input, which is what raises the software keyboard — the
 * single most important thing a touch terminal has to get right, because
 * without it there is no way to type at all.
 */
export const wasTap = (gesture: Gesture, start: Touch, x: number, y: number, elapsed: number): boolean =>
  gesture.kind === "pending" && elapsed < LONG_PRESS_MS && Math.hypot(x - start.x, y - start.y) <= SLOP

/**
 * Whole lines to scroll for a drag, and the pixels left over.
 *
 * The remainder is returned rather than dropped so the caller can carry it into
 * the next move. Without that a slow drag scrolls nothing at all: each event
 * moves a few pixels, every one of them rounds to zero lines, and the content
 * sits still under a finger that is plainly moving.
 *
 * Positive `dy` is a finger moving down, which drags the content down, which
 * means going *back* through history — the direction the page moves, not the
 * direction the viewport does.
 */
export const scrollLines = (dy: number, cellHeight: number): { lines: number; remainder: number } => {
  if (cellHeight <= 0) return { lines: 0, remainder: 0 }
  const lines = Math.trunc(dy / cellHeight)
  return { lines, remainder: dy - lines * cellHeight }
}
