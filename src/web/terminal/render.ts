import { cellSize, DEFAULT_FONT_SIZE, fontFor, gridFor } from "./metrics.ts"
import { BACKGROUND, CURSOR, isDefaultBackground, resolve } from "./palette.ts"
import { FLAG, type Terminal } from "./vt.ts"

/**
 * Draws the grid to a canvas.
 *
 * Canvas rather than DOM nodes: a full screen is several thousand cells, and
 * one element per cell makes scrolling a layout problem instead of a paint.
 * Rows are only redrawn when the emulator says they changed, so an idle
 * terminal costs nothing — the same damage-driven approach the iOS renderer
 * uses, for the same reason.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D
  cellWidth = 8
  cellHeight = 17
  private ascent = 12
  private dpr = 1
  private dirty = new Set<number>()
  private full = true
  private fontSize: number
  private lastOffset = 0
  private wheelResidual = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private term: () => Terminal | null,
    fontSize = DEFAULT_FONT_SIZE,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) throw new Error("This browser has no 2D canvas.")
    this.ctx = ctx
    this.fontSize = fontSize
    this.measure()
  }

  setFontSize(size: number) {
    this.fontSize = size
    this.measure()
    this.full = true
  }

  private font(bold: boolean, italic: boolean) {
    return fontFor(this.fontSize, bold, italic)
  }

  private measure() {
    const cell = cellSize(this.fontSize)
    this.cellWidth = cell.width
    this.cellHeight = cell.height
    this.ascent = cell.ascent
  }

  /**
   * Grid size for the element's current size.
   *
   * Shared with the code that creates the pty, so a session is born the size it
   * will be drawn at — see metrics.ts.
   */
  gridFor(width: number, height: number) {
    return gridFor(width, height, this.fontSize)
  }

  resizeCanvas(width: number, height: number) {
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.floor(width * this.dpr)
    this.canvas.height = Math.floor(height * this.dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.measure()
    this.full = true
  }

  markDamage(rows: number[] | null | "none") {
    if (rows === "none") return
    if (rows === null) this.full = true
    else for (const r of rows) this.dirty.add(r)
  }

  invalidate() {
    this.full = true
  }

  /**
   * Rows a wheel event should move the view by, positive downward.
   *
   * `deltaMode` has to be honoured: a trackpad reports pixels, a mouse wheel
   * reports lines, and a few browsers report pages. Sub-row remainders are
   * carried rather than rounded away, or a slow trackpad drag moves nothing
   * at all.
   */
  linesForWheel(deltaY: number, deltaMode: number): number {
    let pixels = deltaY
    if (deltaMode === 1) pixels = deltaY * this.cellHeight
    if (deltaMode === 2) pixels = deltaY * this.viewportRows() * this.cellHeight
    this.wheelResidual += pixels
    const lines = Math.trunc(this.wheelResidual / this.cellHeight)
    this.wheelResidual -= lines * this.cellHeight
    return lines
  }

  private viewportRows() {
    return Math.max(1, Math.floor(this.canvas.height / this.dpr / this.cellHeight))
  }

  /** Returns true when anything was painted. */
  draw(): boolean {
    const term = this.term()
    if (!term) return false

    // Scrolling shifts every visible row, and it happens with no bytes
    // arriving to pull damage — so the offset is checked before the early out,
    // not after it.
    const offset = term.displayOffset()
    if (offset !== this.lastOffset) {
      this.lastOffset = offset
      this.full = true
    }
    if (!this.full && this.dirty.size === 0) return false

    const snap = term.snapshot()
    if (!snap) return false
    const { screen, cells } = snap

    const ctx = this.ctx
    ctx.textBaseline = "alphabetic"

    const rows = this.full ? [...Array(screen.rows).keys()] : [...this.dirty]
    if (this.full) {
      ctx.fillStyle = BACKGROUND
      ctx.fillRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr)
    }

    for (const r of rows) {
      if (r >= screen.rows) continue
      const y = r * this.cellHeight
      if (!this.full) {
        ctx.fillStyle = BACKGROUND
        ctx.fillRect(0, y, this.canvas.width / this.dpr, this.cellHeight)
      }

      // Backgrounds first, coalesced: a run of one colour is one fillRect
      // rather than eighty.
      let c = 0
      while (c < screen.cols) {
        const cell = term.cellAt(cells, r * screen.cols + c)
        const inverse = (cell.flags & FLAG.inverse) !== 0
        const bg = inverse ? cell.fg : cell.bg
        if (isDefaultBackground(bg) && !inverse) {
          c++
          continue
        }
        let end = c
        while (end < screen.cols) {
          const next = term.cellAt(cells, r * screen.cols + end)
          const nextInverse = (next.flags & FLAG.inverse) !== 0
          if ((nextInverse ? next.fg : next.bg) !== bg) break
          end++
        }
        ctx.fillStyle = resolve(bg, inverse)
        ctx.fillRect(c * this.cellWidth, y, (end - c) * this.cellWidth, this.cellHeight)
        c = end
      }

      // Then glyphs, coalesced by colour and style.
      c = 0
      while (c < screen.cols) {
        const cell = term.cellAt(cells, r * screen.cols + c)
        const inverse = (cell.flags & FLAG.inverse) !== 0
        const fg = inverse ? cell.bg : cell.fg
        const style = cell.flags & (FLAG.bold | FLAG.italic)
        let text = ""
        const start = c
        while (c < screen.cols) {
          const n = term.cellAt(cells, r * screen.cols + c)
          const nInverse = (n.flags & FLAG.inverse) !== 0
          const nFg = nInverse ? n.bg : n.fg
          if (nFg !== fg || (n.flags & (FLAG.bold | FLAG.italic)) !== style) break
          if (n.flags & FLAG.invisible || n.ch === 0) {
            // A wide character's spacer carries no glyph; emitting anything
            // would shove the rest of the row one column right.
            if (n.ch !== 0) text += " "
          } else {
            text += String.fromCodePoint(n.ch)
          }
          c++
        }
        if (c === start) c++
        if (text.trim()) {
          ctx.font = this.font((style & FLAG.bold) !== 0, (style & FLAG.italic) !== 0)
          ctx.fillStyle = resolve(fg, true)
          if (cell.flags & FLAG.dim) ctx.globalAlpha = 0.6
          ctx.fillText(text, start * this.cellWidth, y + this.ascent)
          ctx.globalAlpha = 1
        }
        if (cell.flags & FLAG.underline) {
          ctx.fillStyle = resolve(fg, true)
          ctx.fillRect(start * this.cellWidth, y + this.ascent + 2, (c - start) * this.cellWidth, 1)
        }
        if (cell.flags & FLAG.strikethrough) {
          ctx.fillStyle = resolve(fg, true)
          ctx.fillRect(start * this.cellWidth, y + this.ascent * 0.6, (c - start) * this.cellWidth, 1)
        }
      }
    }

    // The snapshot reports the cursor in live-grid coordinates whatever the
    // display offset is, so while scrolled back its row is a history line the
    // cursor has nothing to do with. Painting it there puts a solid block over
    // an unrelated character.
    if (offset === 0 && screen.cursorVisible && screen.cursorRow < screen.rows) {
      // The cursor sits on a row that may not have been in the damage list, so
      // its row is repainted next frame regardless.
      this.dirty.add(screen.cursorRow)
      ctx.fillStyle = CURSOR
      ctx.fillRect(
        screen.cursorCol * this.cellWidth,
        screen.cursorRow * this.cellHeight,
        this.cellWidth,
        this.cellHeight,
      )
      const under = term.cellAt(cells, screen.cursorRow * screen.cols + screen.cursorCol)
      if (under.ch && under.ch !== 32) {
        ctx.font = this.font(false, false)
        ctx.fillStyle = BACKGROUND
        ctx.fillText(
          String.fromCodePoint(under.ch),
          screen.cursorCol * this.cellWidth,
          screen.cursorRow * this.cellHeight + this.ascent,
        )
      }
    }

    if (offset > 0) this.drawScrollMark(offset, term.scrollbackLength(), screen.rows)

    const painted = this.full || rows.length > 0
    this.full = false
    this.dirty.clear()
    return painted
  }

  /**
   * A thumb on the right edge while the view is back in history: where you are
   * and how much is above and below you, in the place a scrollbar would be.
   *
   * Redrawn on every painted frame rather than only on the scroll, because a
   * partial repaint of a dirty row erases the part of it that row covers.
   */
  private drawScrollMark(offset: number, scrollback: number, rows: number) {
    const ctx = this.ctx
    const height = this.canvas.height / this.dpr
    const width = this.canvas.width / this.dpr
    const total = scrollback + rows
    if (total <= rows) return

    const thumb = Math.max(24, (rows / total) * height)
    const top = ((scrollback - offset) / total) * (height - thumb)

    ctx.globalAlpha = 0.5
    ctx.fillStyle = CURSOR
    ctx.fillRect(width - 3, top, 2, thumb)
    ctx.globalAlpha = 1
  }
}
