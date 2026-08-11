/**
 * Turning pointer gestures into the bytes a program expects.
 *
 * Nothing here was being sent at all, which is why the wheel appeared broken.
 * A full-screen program runs on the alternate screen, the alternate screen
 * keeps no scrollback, and the client only knew how to move through
 * scrollback — so inside the one kind of program this product exists to run,
 * the wheel did nothing and the page scrolled instead.
 */

export type PointerModes = {
  altScreen: boolean
  reportClick: boolean
  reportDrag: boolean
  reportMotion: boolean
  sgr: boolean
  altScroll: boolean
}

/** Button numbers as the wire format counts them. */
export const BUTTON = { left: 0, middle: 1, right: 2, wheelUp: 64, wheelDown: 65 } as const

const encoder = new TextEncoder()

/**
 * One mouse event.
 *
 * SGR (?1006) when the program asked for it, X10 otherwise. X10 is the
 * fallback rather than the default because it encodes a coordinate as
 * `32 + n` in a single byte, so it cannot express a column past 223 — on a
 * terminal this wide that is most of the screen, and the failure is a click
 * landing somewhere else entirely rather than an error.
 */
export const mouseReport = (
  modes: PointerModes,
  button: number,
  col: number,
  row: number,
  press: boolean,
  modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): Uint8Array | null => {
  if (!modes.reportClick) return null

  // Columns and rows are 1-based on the wire.
  const x = col + 1
  const y = row + 1
  let b = button
  if (modifiers.shift) b += 4
  if (modifiers.alt) b += 8
  if (modifiers.ctrl) b += 16

  if (modes.sgr) {
    return encoder.encode(`\x1b[<${b};${x};${y}${press ? "M" : "m"}`)
  }
  // X10 has no release button, only "some button went up" — 3.
  const legacy = press ? b : 3
  if (x > 223 || y > 223) return null
  return new Uint8Array([0x1b, 0x5b, 0x4d, 32 + legacy, 32 + x, 32 + y])
}

/** Motion while a button is held, which only some modes want. */
export const mouseMotionReport = (
  modes: PointerModes,
  button: number,
  col: number,
  row: number,
  held: boolean,
): Uint8Array | null => {
  if (!modes.reportMotion && !(modes.reportDrag && held)) return null
  // 32 marks the event as motion rather than a fresh press.
  return mouseReport(modes, (held ? button : 3) + 32, col, row, true)
}

/**
 * What the wheel should do, given what the program has asked for.
 *
 * Three cases, in the order every other terminal resolves them:
 *
 *  - the program is reading the mouse itself, so send it the wheel and let it
 *    decide;
 *  - the alternate screen with alternate scroll (?1007, on by default), where
 *    there is no scrollback to move through, so the wheel becomes arrow keys —
 *    which is what makes a pager or a TUI list scroll;
 *  - anything else, which means move the local view through scrollback.
 */
export type WheelAction =
  | { kind: "report"; bytes: Uint8Array }
  | { kind: "keys"; bytes: Uint8Array }
  | { kind: "scrollback"; lines: number }
  | { kind: "page" }

export const wheelAction = (
  modes: PointerModes,
  lines: number,
  col: number,
  row: number,
  hasScrollback: boolean,
  cursorApp = false,
): WheelAction => {
  if (lines === 0) return { kind: "page" }
  const up = lines < 0
  const count = Math.min(Math.abs(lines), 10)

  if (modes.reportClick) {
    const button = up ? BUTTON.wheelUp : BUTTON.wheelDown
    const parts: number[] = []
    for (let i = 0; i < count; i++) {
      const one = mouseReport(modes, button, col, row, true)
      if (one) parts.push(...one)
    }
    if (parts.length) return { kind: "report", bytes: new Uint8Array(parts) }
  }

  if (modes.altScreen) {
    if (!modes.altScroll) return { kind: "page" }
    // Arrow keys, three rows per notch — xterm's ratio, and what the programs
    // that read them are tuned for.
    //
    // In the cursor-key spelling the program actually asked for. A TUI that
    // has set DECCKM expects `ESC O A` and ignores `ESC [ A`, which is the
    // same trap the core's key-modes documentation describes — and getting it
    // wrong here means the wheel is dead again, in a way that looks identical
    // to sending nothing at all.
    const seq = cursorApp ? (up ? "\x1bOA" : "\x1bOB") : up ? "\x1b[A" : "\x1b[B"
    return { kind: "keys", bytes: encoder.encode(seq.repeat(count * 3)) }
  }

  if (!hasScrollback) return { kind: "page" }
  return { kind: "scrollback", lines }
}
