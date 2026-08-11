import { describe, expect, test } from "bun:test"
import { BUTTON, mouseReport, type PointerModes, wheelAction } from "../src/web/terminal/mouse.ts"

/**
 * What the wheel and the pointer send.
 *
 * The bug these exist for produced no error and no output: inside a
 * full-screen program the wheel did nothing at all, because the client only
 * knew how to move through scrollback and the alternate screen keeps none.
 */

const modes = (over: Partial<PointerModes> = {}): PointerModes => ({
  altScreen: false,
  reportClick: false,
  reportDrag: false,
  reportMotion: false,
  sgr: false,
  altScroll: true,
  ...over,
})

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe("the wheel on the alternate screen", () => {
  test("becomes arrow keys, because there is no scrollback to move", () => {
    // This is the whole bug. A pager or a TUI list is on the alternate screen,
    // which keeps no history, so "scroll the scrollback" is a no-op and the
    // gesture fell through to the page.
    const a = wheelAction(modes({ altScreen: true }), 1, 0, 0, false)
    expect(a.kind).toBe("keys")
    expect(text((a as any).bytes)).toBe("\x1b[B".repeat(3))
  })

  test("in the cursor-key spelling the program asked for", () => {
    // A TUI that set DECCKM expects ESC O B and ignores ESC [ B — the same
    // trap the core's key-modes documentation describes. Getting it wrong
    // leaves the wheel dead in a way indistinguishable from sending nothing.
    const a = wheelAction(modes({ altScreen: true }), 1, 0, 0, false, true)
    expect(text((a as any).bytes)).toBe("\x1bOB".repeat(3))
  })

  test("scrolls up with the up arrow", () => {
    const a = wheelAction(modes({ altScreen: true }), -1, 0, 0, false)
    expect(text((a as any).bytes)).toBe("\x1b[A".repeat(3))
  })

  test("is left to the page when the program turned alternate scroll off", () => {
    // ?1007 off means the program wants the wheel to do nothing here.
    expect(wheelAction(modes({ altScreen: true, altScroll: false }), 1, 0, 0, false).kind).toBe("page")
  })
})

describe("the wheel elsewhere", () => {
  test("moves through scrollback when there is any", () => {
    const a = wheelAction(modes(), 3, 0, 0, true)
    expect(a).toEqual({ kind: "scrollback", lines: 3 })
  })

  test("is left to the page when there is nothing to scroll", () => {
    // A short session on the primary screen: the terminal has no history, so
    // the gesture belongs to the document.
    expect(wheelAction(modes(), 3, 0, 0, false).kind).toBe("page")
  })

  test("a gesture too small to move a row does nothing", () => {
    expect(wheelAction(modes(), 0, 0, 0, true).kind).toBe("page")
  })
})

describe("the wheel when the program reads the mouse itself", () => {
  test("is handed straight to it, wherever the screen is", () => {
    // Claude Code and anything else that enables mouse reporting wants the
    // wheel as an event, not as arrow keys.
    const a = wheelAction(modes({ altScreen: true, reportClick: true, sgr: true }), 1, 4, 9, false)
    expect(a.kind).toBe("report")
    expect(text((a as any).bytes)).toBe(`\x1b[<${BUTTON.wheelDown};5;10M`)
  })

  test("one report per row, so a fast flick is not one notch", () => {
    const a = wheelAction(modes({ reportClick: true, sgr: true }), 3, 0, 0, true)
    expect(text((a as any).bytes).match(/M/g)?.length).toBe(3)
  })
})

describe("encoding a click", () => {
  test("says nothing at all when the program did not ask", () => {
    // Sending mouse bytes to a shell that never enabled reporting prints them.
    expect(mouseReport(modes(), 0, 3, 4, true)).toBeNull()
  })

  test("SGR carries press and release apart", () => {
    const m = modes({ reportClick: true, sgr: true })
    expect(text(mouseReport(m, 0, 3, 4, true)!)).toBe("\x1b[<0;4;5M")
    expect(text(mouseReport(m, 0, 3, 4, false)!)).toBe("\x1b[<0;4;5m")
  })

  test("modifiers ride on the button number", () => {
    const m = modes({ reportClick: true, sgr: true })
    expect(text(mouseReport(m, 0, 0, 0, true, { shift: true })!)).toBe("\x1b[<4;1;1M")
    expect(text(mouseReport(m, 0, 0, 0, true, { ctrl: true })!)).toBe("\x1b[<16;1;1M")
  })

  test("the legacy encoding refuses a column it cannot express", () => {
    // X10 packs a coordinate as 32+n in one byte, so it stops at 223. On a
    // terminal this wide that is most of the screen, and the failure mode is a
    // click landing somewhere else rather than an error — better to send
    // nothing than to send a lie.
    const m = modes({ reportClick: true, sgr: false })
    expect(mouseReport(m, 0, 10, 10, true)).not.toBeNull()
    expect(mouseReport(m, 0, 300, 10, true)).toBeNull()
  })
})
