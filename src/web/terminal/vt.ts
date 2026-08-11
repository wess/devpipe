/**
 * The browser's binding to sinclair's terminal emulator.
 *
 * This is the same Rust crate the iPad app links against, compiled to
 * WebAssembly instead of arm64. Web and iOS therefore agree on what a byte
 * stream means — cursor movement, wide characters, scroll regions, colour —
 * because there is one implementation, not two that were made to look alike.
 */

export type Cell = {
  ch: number
  fg: number
  bg: number
  flags: number
}

export type Screen = {
  cols: number
  rows: number
  cursorRow: number
  cursorCol: number
  cursorVisible: boolean
  altScreen: boolean
}

export const FLAG = {
  bold: 1 << 0,
  dim: 1 << 1,
  italic: 1 << 2,
  underline: 1 << 3,
  strikethrough: 1 << 8,
  inverse: 1 << 9,
  invisible: 1 << 10,
  wideSpacer: 1 << 13,
} as const

type Exports = {
  memory: WebAssembly.Memory
  dp_term_new(cols: number, rows: number, scrollback: number): number
  dp_term_free(t: number): void
  dp_term_feed(t: number, ptr: number, len: number): void
  dp_term_resize(t: number, cols: number, rows: number): void
  dp_term_snapshot(t: number, out: number): number
  dp_term_take_output(t: number, lenPtr: number): number
  dp_term_take_damage(t: number, rows: number, cap: number): number
  dp_term_key_modes(t: number): number
  dp_term_link_at(t: number, row: number, col: number, s: number, e: number): number
  dp_term_scroll(t: number, delta: number): void
  dp_term_display_offset(t: number): number
  dp_term_scrollback_len(t: number): number
  dp_term_scroll_to_bottom(t: number): void
  dp_alloc(len: number): number
  dp_free(ptr: number, len: number): void
  dp_cell_size(): number
}

let wasm: Exports | null = null

export const loadVt = async (source: string | BufferSource = "/vt.wasm"): Promise<void> => {
  if (wasm) return
  // Accepts bytes as well as a URL so the module can be exercised outside a
  // browser — the emulator is the piece both clients depend on, and a test
  // that cannot load it is a test that cannot check it.
  const result =
    typeof source === "string"
      ? await WebAssembly.instantiateStreaming(fetch(source), {})
      : await WebAssembly.instantiate(source, {})
  // `instantiate` returns a source-and-instance pair for bytes and a bare
  // instance for an already-compiled module; only the first form reaches here,
  // but the type covers both.
  const instance = "instance" in result ? result.instance : (result as WebAssembly.Instance)
  const exports = instance.exports as unknown as Exports

  // A .wasm older than this file loads without complaint and then throws from
  // inside the render loop on the first missing export — and because the frame
  // callback schedules the next frame after drawing, one throw stops the
  // terminal for good. Check the newest symbols here so a stale build says so
  // once, at startup, and names the fix.
  for (const name of ["dp_term_display_offset", "dp_term_scrollback_len", "dp_term_scroll_to_bottom"]) {
    if (typeof (exports as unknown as Record<string, unknown>)[name] !== "function") {
      throw new Error(
        `vt.wasm is missing ${name}. Rebuild it: cd core && cargo build --release --target wasm32-unknown-unknown`,
      )
    }
  }
  wasm = exports
}

export const vtReady = () => wasm !== null

const SCREEN_BYTES = 20

export class Terminal {
  private handle: number
  private screenPtr: number
  private cellSize: number
  private damagePtr: number
  private damageCap: number

  constructor(
    public cols: number,
    public rows: number,
    scrollback = 10_000,
  ) {
    if (!wasm) throw new Error("loadVt() must finish before a Terminal is created")
    this.handle = wasm.dp_term_new(cols, rows, scrollback)
    this.screenPtr = wasm.dp_alloc(SCREEN_BYTES)
    this.cellSize = wasm.dp_cell_size()
    this.damageCap = 512
    this.damagePtr = wasm.dp_alloc(this.damageCap * 4)
  }

  dispose() {
    if (!wasm) return
    wasm.dp_term_free(this.handle)
    wasm.dp_free(this.screenPtr, SCREEN_BYTES)
    wasm.dp_free(this.damagePtr, this.damageCap * 4)
    this.handle = 0
  }

  feed(bytes: Uint8Array) {
    if (!wasm || !bytes.length) return
    const ptr = wasm.dp_alloc(bytes.length)
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes)
    wasm.dp_term_feed(this.handle, ptr, bytes.length)
    wasm.dp_free(ptr, bytes.length)
  }

  resize(cols: number, rows: number) {
    if (!wasm || (cols === this.cols && rows === this.rows)) return
    this.cols = cols
    this.rows = rows
    wasm.dp_term_resize(this.handle, cols, rows)
  }

  /** Positive scrolls back into history, negative toward the live bottom. */
  scroll(delta: number) {
    wasm?.dp_term_scroll(this.handle, delta)
  }

  /** Rows above the live bottom; 0 means the snapshot is the running screen. */
  displayOffset(): number {
    return wasm?.dp_term_display_offset(this.handle) ?? 0
  }

  /** Rows of history behind the screen, and so the furthest a scroll can go. */
  scrollbackLength(): number {
    return wasm?.dp_term_scrollback_len(this.handle) ?? 0
  }

  scrollToBottom() {
    wasm?.dp_term_scroll_to_bottom(this.handle)
  }

  atBottom(): boolean {
    return this.displayOffset() === 0
  }

  /**
   * Bytes the emulator owes the pty — cursor position reports, device
   * attributes. Dropping these hangs anything that asks the terminal a
   * question and waits for the answer.
   */
  takeOutput(): Uint8Array | null {
    if (!wasm) return null
    const lenPtr = wasm.dp_alloc(4)
    const ptr = wasm.dp_term_take_output(this.handle, lenPtr)
    const len = new Uint32Array(wasm.memory.buffer, lenPtr, 1)[0]
    wasm.dp_free(lenPtr, 4)
    if (!ptr || !len) return null
    return new Uint8Array(wasm.memory.buffer, ptr, len).slice()
  }

  /** `null` for full damage, otherwise the rows that changed. */
  takeDamage(): number[] | null | "none" {
    if (!wasm) return "none"
    const n = wasm.dp_term_take_damage(this.handle, this.damagePtr, this.damageCap)
    if (n < 0) return null
    if (n === 0) return "none"
    return Array.from(new Uint32Array(wasm.memory.buffer, this.damagePtr, n))
  }

  keyModes() {
    const raw = wasm?.dp_term_key_modes(this.handle) ?? 0
    return {
      cursorApp: (raw & 1) !== 0,
      keypadApp: (raw & 2) !== 0,
      bracketedPaste: (raw & 4) !== 0,
    }
  }

  linkAt(row: number, col: number): { url: string; startCol: number; endCol: number } | null {
    if (!wasm) return null
    const sPtr = wasm.dp_alloc(4)
    const ePtr = wasm.dp_alloc(4)
    const ptr = wasm.dp_term_link_at(this.handle, row, col, sPtr, ePtr)
    if (!ptr) {
      wasm.dp_free(sPtr, 4)
      wasm.dp_free(ePtr, 4)
      return null
    }
    const view = new Uint32Array(wasm.memory.buffer, sPtr, 1)
    const startCol = view[0]
    const endCol = new Uint32Array(wasm.memory.buffer, ePtr, 1)[0]
    wasm.dp_free(sPtr, 4)
    wasm.dp_free(ePtr, 4)

    const bytes = new Uint8Array(wasm.memory.buffer, ptr)
    let end = 0
    while (bytes[end] !== 0) end++
    const url = new TextDecoder().decode(bytes.subarray(0, end))
    // A terminal will happily print `javascript:`; only hand the browser
    // things it makes sense to open from a click on remote output.
    if (!/^https?:\/\//i.test(url)) return null
    return { url, startCol, endCol }
  }

  /**
   * Reads the visible grid. The returned views point into wasm memory and are
   * only valid until the next call that allocates — the renderer consumes them
   * immediately and never stores them.
   */
  snapshot(): { screen: Screen; cells: DataView } | null {
    if (!wasm) return null
    const ptr = wasm.dp_term_snapshot(this.handle, this.screenPtr)
    if (!ptr) return null
    const s = new DataView(wasm.memory.buffer, this.screenPtr, SCREEN_BYTES)
    const screen: Screen = {
      cols: s.getUint32(0, true),
      rows: s.getUint32(4, true),
      cursorRow: s.getUint32(8, true),
      cursorCol: s.getUint32(12, true),
      cursorVisible: s.getUint8(16) !== 0,
      altScreen: s.getUint8(18) !== 0,
    }
    const cells = new DataView(wasm.memory.buffer, ptr, screen.cols * screen.rows * this.cellSize)
    return { screen, cells }
  }

  cellAt(cells: DataView, index: number): Cell {
    const at = index * this.cellSize
    return {
      ch: cells.getUint32(at, true),
      fg: cells.getUint32(at + 4, true),
      bg: cells.getUint32(at + 8, true),
      flags: cells.getUint16(at + 12, true),
    }
  }
}
