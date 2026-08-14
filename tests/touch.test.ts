import { describe, expect, test } from "bun:test"
import { classify, type Gesture, LONG_PRESS_MS, SLOP, scrollLines, type Touch, wasTap } from "../src/web/terminal/touch.ts"

/**
 * What a finger meant.
 *
 * A mouse and a finger want opposite defaults — drag selects with one and
 * scrolls with the other — and getting that backwards makes scrollback
 * unreachable on the device the whole touch layer exists for.
 */

const down = (x = 100, y = 100): Touch => ({ x, y, at: 0 })
const pending: Gesture = { kind: "pending" }

describe("deciding what a finger is doing", () => {
  test("a drag scrolls", () => {
    expect(classify(pending, down(), 100, 160, 50).kind).toBe("scroll")
  })

  test("holding still selects", () => {
    expect(classify(pending, down(), 100, 100, LONG_PRESS_MS).kind).toBe("select")
  })

  test("a finger resting on glass is still a tap", () => {
    // A finger that has not moved by human standards has moved by the
    // browser's. Reading that as a one-pixel scroll leaves the keyboard shut
    // with nothing on screen saying why.
    expect(classify(pending, down(), 100 + SLOP - 1, 100, 50).kind).toBe("pending")
  })

  test("a gesture never changes its mind", () => {
    // Dragging to extend a selection travels much further than the slop, and
    // re-deciding partway would turn it into a scroll and lose the selection.
    const selecting: Gesture = { kind: "select" }
    expect(classify(selecting, down(), 400, 900, 2000).kind).toBe("select")
    const scrolling: Gesture = { kind: "scroll" }
    expect(classify(scrolling, down(), 100, 100, 5000).kind).toBe("scroll")
  })

  test("moving beats waiting", () => {
    // Past the slop and past the delay at the same moment: a finger that has
    // travelled was dragging, whatever the clock says.
    expect(classify(pending, down(), 300, 300, LONG_PRESS_MS + 100).kind).toBe("scroll")
  })
})

describe("the tap that raises the keyboard", () => {
  test("still and quick", () => {
    expect(wasTap(pending, down(), 102, 101, 80)).toBe(true)
  })

  test("not a long press", () => {
    expect(wasTap(pending, down(), 100, 100, LONG_PRESS_MS + 1)).toBe(false)
  })

  test("not a drag", () => {
    expect(wasTap(pending, down(), 300, 100, 80)).toBe(false)
  })

  test("and never a gesture that already did something", () => {
    expect(wasTap({ kind: "scroll" }, down(), 100, 100, 10)).toBe(false)
    expect(wasTap({ kind: "select" }, down(), 100, 100, 10)).toBe(false)
  })
})

describe("turning a drag into lines", () => {
  test("a whole cell is a line", () => {
    expect(scrollLines(20, 20)).toEqual({ lines: 1, remainder: 0 })
  })

  test("what does not divide is carried, not dropped", () => {
    // The failure this exists for: a slow drag moves a few pixels per event,
    // each rounds to zero lines, and the content sits still under a finger
    // that is plainly moving.
    const first = scrollLines(7, 20)
    expect(first.lines).toBe(0)
    const second = scrollLines(7 + first.remainder, 20)
    const third = scrollLines(7 + second.remainder, 20)
    expect(third.lines).toBe(1)
  })

  test("upward is negative, toward the live bottom", () => {
    expect(scrollLines(-40, 20).lines).toBe(-2)
  })

  test("a remainder never grows past a cell", () => {
    for (const dy of [1, 19, 21, 39, -1, -19, -21]) {
      expect(Math.abs(scrollLines(dy, 20).remainder)).toBeLessThan(20)
    }
  })

  test("no cell height is no scrolling, rather than a division by zero", () => {
    expect(scrollLines(100, 0)).toEqual({ lines: 0, remainder: 0 })
  })
})
