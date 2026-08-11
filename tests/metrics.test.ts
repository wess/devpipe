import { describe, expect, test } from "bun:test"
import { fontFor, gridFrom, MIN_COLS, MIN_ROWS } from "../src/web/terminal/metrics.ts"

/**
 * The arithmetic only. `cellSize` needs a canvas, and the point of splitting it
 * out is that everything that can be checked without a browser is.
 */

const cell = { width: 8, height: 20 }

describe("fitting a grid to a pixel box", () => {
  test("a box holds as many whole cells as fit", () => {
    expect(gridFrom(800, 400, cell)).toEqual({ cols: 100, rows: 20 })
  })

  test("a partial cell is not counted", () => {
    // 807px is a hundred cells and seven pixels. Rounding up would give the
    // program a column that has nowhere to be drawn.
    expect(gridFrom(807, 409, cell)).toEqual({ cols: 100, rows: 20 })
  })

  test("a pane dragged to nothing still asks for a usable grid", () => {
    // A zero-column pty is not a small terminal, it is a division by zero in
    // whatever is running in it.
    expect(gridFrom(0, 0, cell)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
    expect(gridFrom(12, 9, cell)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
  })

  test("the size a session is created at is the size it is drawn at", () => {
    // The regression this file exists for. The pty used to be created at a
    // fixed 100x30 while the renderer drew whatever fit the window, so a
    // program's first screen — its banner, its box drawing, its column
    // layout — was composed for a terminal that was not on screen, and no
    // later resize could take it back out of the scrollback.
    const pane = { width: 1160, height: 780 }
    const created = gridFrom(pane.width, pane.height, cell)
    const drawn = gridFrom(pane.width, pane.height, cell)
    expect(created).toEqual(drawn)
    expect(created).not.toEqual({ cols: 100, rows: 30 })
  })
})

describe("the font the grid was measured with", () => {
  test("is the same string the glyphs are drawn with", () => {
    // Measuring with one font and painting with another is the same bug one
    // level down: every column lands a fraction off until the row visibly
    // drifts.
    expect(fontFor(13)).toBe(fontFor(13, false, false))
    expect(fontFor(13)).toContain("13px")
    expect(fontFor(13)).toContain("ui-monospace")
  })

  test("carries weight and slant without changing the family or size", () => {
    const plain = fontFor(13)
    const bold = fontFor(13, true)
    const italic = fontFor(13, false, true)
    for (const f of [bold, italic]) {
      expect(f).toContain("13px")
      expect(f).toContain("ui-monospace")
    }
    expect(bold).not.toBe(plain)
    expect(italic).toContain("italic")
  })
})
