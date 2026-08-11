import { beforeAll, describe, expect, test } from "bun:test"
import { FLAG, Terminal, loadVt } from "../src/web/terminal/vt.ts"
import { db, truncateAll } from "./setup.ts"

const WASM = "core/target/wasm32-unknown-unknown/release/devpipecore.wasm"

const textOf = (t: Terminal, row: number): string => {
  const snap = t.snapshot()!
  let out = ""
  for (let c = 0; c < snap.screen.cols; c++) {
    const cell = t.cellAt(snap.cells, row * snap.screen.cols + c)
    out += cell.ch === 0 ? "" : String.fromCodePoint(cell.ch)
  }
  return out.trimEnd()
}

/** `n` numbered lines, each on its own row. */
const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i}\r\n`).join("")

describe("the terminal core, in WebAssembly", () => {
  beforeAll(async () => {
    await loadVt(await Bun.file(WASM).arrayBuffer())
  })

  test("plain text lands in the grid", () => {
    const t = new Terminal(20, 4)
    t.feed(new TextEncoder().encode("hello"))
    expect(textOf(t, 0)).toBe("hello")
    expect(t.snapshot()!.screen.cursorCol).toBe(5)
    t.dispose()
  })

  test("colours survive the trip through wasm memory", () => {
    const t = new Terminal(20, 2)
    t.feed(new TextEncoder().encode("\x1b[38;2;255;0;0mR\x1b[48;5;33mB"))
    const snap = t.snapshot()!
    // Same packing the iOS client reads: tag << 24 | payload.
    expect(t.cellAt(snap.cells, 0).fg).toBe((2 << 24) | (255 << 16))
    expect(t.cellAt(snap.cells, 1).bg).toBe((1 << 24) | 33)
    t.dispose()
  })

  test("a wide character blanks its spacer", () => {
    const t = new Terminal(10, 2)
    t.feed(new TextEncoder().encode("世"))
    const snap = t.snapshot()!
    expect(t.cellAt(snap.cells, 0).ch).toBe("世".codePointAt(0)!)
    expect(t.cellAt(snap.cells, 1).ch).toBe(0)
    t.dispose()
  })

  test("a cursor position report comes back for the pty", () => {
    const t = new Terminal(80, 24)
    t.feed(new TextEncoder().encode("\x1b[6n"))
    const out = t.takeOutput()
    expect(out).not.toBeNull()
    expect(new TextDecoder().decode(out!)).toBe("\x1b[1;1R")
    t.dispose()
  })

  test("a printed url is findable, and javascript: is not offered", () => {
    const t = new Terminal(80, 3)
    t.feed(new TextEncoder().encode("Open https://claude.com/cai/oauth/authorize?code=true now"))
    const hit = t.linkAt(0, 12)
    expect(hit?.url).toBe("https://claude.com/cai/oauth/authorize?code=true")
    expect(t.linkAt(0, 2)).toBeNull()

    const t2 = new Terminal(80, 3)
    t2.feed(new TextEncoder().encode("javascript:alert(1)"))
    expect(t2.linkAt(0, 4)).toBeNull()
    t.dispose()
    t2.dispose()
  })

  test("key modes are reported so arrows can be encoded correctly", () => {
    const t = new Terminal(40, 5)
    expect(t.keyModes().cursorApp).toBe(false)
    t.feed(new TextEncoder().encode("\x1b[?1h"))
    expect(t.keyModes().cursorApp).toBe(true)
    t.dispose()
  })

  test("damage is reported so an idle screen costs nothing", () => {
    const t = new Terminal(40, 5)
    t.takeDamage()
    expect(t.takeDamage()).toBe("none")
    t.feed(new TextEncoder().encode("x"))
    expect(t.takeDamage()).not.toBe("none")
    t.dispose()
  })

  test("resize reflows without going out of bounds", () => {
    const t = new Terminal(80, 24)
    t.feed(new TextEncoder().encode("x".repeat(500)))
    t.resize(40, 12)
    const snap = t.snapshot()!
    expect(snap.screen.cols).toBe(40)
    expect(snap.screen.rows).toBe(12)
    t.dispose()
  })

  test("inverse video is flagged for the renderer to swap", () => {
    const t = new Terminal(20, 2)
    t.feed(new TextEncoder().encode("\x1b[7mX"))
    const snap = t.snapshot()!
    expect(t.cellAt(snap.cells, 0).flags & FLAG.inverse).toBeGreaterThan(0)
    t.dispose()
  })

  test("output past the screen goes to scrollback and can be scrolled back to", () => {
    const t = new Terminal(20, 4)
    t.feed(new TextEncoder().encode(lines(10)))
    // Ten lines plus the row the cursor sits on, through four rows, leaves
    // seven behind.
    expect(t.scrollbackLength()).toBe(7)
    expect(t.displayOffset()).toBe(0)
    expect(textOf(t, 0)).toBe("line 7")

    t.scroll(3)
    expect(t.displayOffset()).toBe(3)
    expect(textOf(t, 0)).toBe("line 4")
    t.dispose()
  })

  test("scrolling past either end clamps", () => {
    const t = new Terminal(20, 4)
    t.feed(new TextEncoder().encode(lines(10)))

    t.scroll(9999)
    expect(t.displayOffset()).toBe(7)
    expect(textOf(t, 0)).toBe("line 0")

    t.scroll(-9999)
    expect(t.displayOffset()).toBe(0)
    expect(t.atBottom()).toBe(true)
    t.dispose()
  })

  test("new output leaves a scrolled-back view where it was", () => {
    const t = new Terminal(20, 4)
    t.feed(new TextEncoder().encode(lines(10)))
    t.scroll(4)
    const held = textOf(t, 0)

    t.feed(new TextEncoder().encode(lines(5)))
    // The whole point: a build printing a line must not take your place away.
    expect(textOf(t, 0)).toBe(held)
    expect(t.atBottom()).toBe(false)

    t.scrollToBottom()
    expect(t.displayOffset()).toBe(0)
    expect(textOf(t, 0)).toBe("line 2")
    t.dispose()
  })

  test("the snapshot reports the live cursor even while scrolled back", () => {
    const t = new Terminal(20, 4)
    t.feed(new TextEncoder().encode(lines(10)))
    const live = t.snapshot()?.screen
    t.scroll(3)
    const back = t.snapshot()?.screen

    // Not offset-aware, and cannot be: the cursor is on the live grid, which
    // is three rows below what is now on screen. Both renderers therefore
    // suppress the cursor whenever the offset is non-zero, or the block lands
    // on a history line it has nothing to do with.
    expect(back?.cursorRow).toBe(live?.cursorRow ?? -1)
    expect(back?.cursorVisible).toBe(true)
    expect(textOf(t, back?.cursorRow ?? 0)).toBe("line 7")
    t.dispose()
  })

  test("the alternate screen has nothing to scroll", () => {
    const t = new Terminal(20, 4)
    t.feed(new TextEncoder().encode(lines(20)))
    t.feed(new TextEncoder().encode("\x1b[?1049h"))
    expect(t.scrollbackLength()).toBe(0)
    t.scroll(5)
    expect(t.displayOffset()).toBe(0)
    t.dispose()
  })
})
