/**
 * Cell geometry, in one place.
 *
 * Two callers turn a pixel box into a column count: the renderer, sizing the
 * grid it paints, and the code that asks the daemon for a pty. They have to
 * agree. When they do not, the program starts up believing it has one terminal
 * and draws its first screen — the banner, the box drawing, the two-column
 * layout — for a width that is not the one on screen. The resize that follows
 * fixes the *next* screen; the first one is already in the scrollback and stays
 * wrong for the life of the session.
 */

/** What the terminal renders at until something asks for another size. */
export const DEFAULT_FONT_SIZE = 13

export const fontFor = (size: number, bold = false, italic = false) =>
  `${italic ? "italic " : ""}${bold ? "600 " : "400 "}${size}px ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace`

/**
 * Floors below which a grid is not worth attaching to. A pane dragged to
 * nothing would otherwise ask for a zero-column pty, and the programs that get
 * one mostly divide by it.
 */
export const MIN_COLS = 20
export const MIN_ROWS = 5

export type Cell = { width: number; height: number; ascent: number }

let scratch: CanvasRenderingContext2D | null = null

/**
 * A canvas that exists only to measure text. Detached from the document, so it
 * costs nothing to keep, and kept rather than remade because measuring runs on
 * every resize observation.
 */
const measurer = () => {
  if (!scratch) {
    const ctx = document.createElement("canvas").getContext("2d")
    if (!ctx) throw new Error("This browser has no 2D canvas.")
    scratch = ctx
  }
  return scratch
}

export const cellSize = (fontSize: number): Cell => {
  const ctx = measurer()
  ctx.font = fontFor(fontSize)
  return {
    // Rounded to whole pixels: fractional advances accumulate across eighty
    // columns into visible drift between a character and the background drawn
    // behind it.
    width: Math.max(1, Math.round(ctx.measureText("M").width)),
    height: Math.max(1, Math.round(fontSize * 1.5)),
    ascent: Math.round(fontSize * 1.12),
  }
}

/**
 * The grid that fits a pixel box. Pure, and separate from measuring, so the
 * arithmetic can be checked without a browser.
 */
export const gridFrom = (width: number, height: number, cell: Pick<Cell, "width" | "height">) => ({
  cols: Math.max(MIN_COLS, Math.floor(width / cell.width)),
  rows: Math.max(MIN_ROWS, Math.floor(height / cell.height)),
})

export const gridFor = (width: number, height: number, fontSize: number = DEFAULT_FONT_SIZE) =>
  gridFrom(width, height, cellSize(fontSize))
