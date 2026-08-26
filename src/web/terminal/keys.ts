/**
 * Turning key presses into the bytes a pty expects.
 *
 * The encodings are not a matter of taste — a TUI that has set DECCKM wants
 * `ESC O A` for up and silently ignores `ESC [ A` — so they live in one
 * explicit mapping rather than falling through browser key names.
 */

export type Modes = {
  cursorApp: boolean
  keypadApp: boolean
  bracketedPaste: boolean
}

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)

export const special = (name: string, modes: Modes): Uint8Array | null => {
  const ss3 = modes.cursorApp ? "\x1bO" : "\x1b["
  const csi = "\x1b["
  switch (name) {
    case "ArrowUp":
      return bytes(`${ss3}A`)
    case "ArrowDown":
      return bytes(`${ss3}B`)
    case "ArrowRight":
      return bytes(`${ss3}C`)
    case "ArrowLeft":
      return bytes(`${ss3}D`)
    case "Home":
      return bytes(`${ss3}H`)
    case "End":
      return bytes(`${ss3}F`)
    case "PageUp":
      return bytes(`${csi}5~`)
    case "PageDown":
      return bytes(`${csi}6~`)
    case "Insert":
      return bytes(`${csi}2~`)
    case "Delete":
      return bytes(`${csi}3~`)
    case "Escape":
      return new Uint8Array([0x1b])
    case "Tab":
      return new Uint8Array([0x09])
    case "ShiftTab":
      return bytes(`${csi}Z`)
    // Carriage return, not newline: the pty's line discipline turns CR into
    // the newline the program sees. Sending LF skips that and many TUIs never
    // see the Enter at all.
    case "Enter":
      return new Uint8Array([0x0d])
    case "Backspace":
      return new Uint8Array([0x7f])
    default:
      if (/^F([1-9]|1[0-2])$/.test(name)) {
        const n = Number(name.slice(1))
        if (n <= 4) return bytes(`\x1bO${["P", "Q", "R", "S"][n - 1]}`)
        const codes: Record<number, number> = {
          5: 15,
          6: 17,
          7: 18,
          8: 19,
          9: 20,
          10: 21,
          11: 23,
          12: 24,
        }
        return bytes(`${csi}${codes[n]}~`)
      }
      return null
  }
}

/** Ctrl collapses a letter to its low five bits: Ctrl+C is 0x03. */
export const control = (ch: string): Uint8Array | null => {
  if (!ch) return null
  const code = ch.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return new Uint8Array([code & 0x1f])
  if (code === 63) return new Uint8Array([0x7f])
  if (code === 32) return new Uint8Array([0x00])
  return null
}

/** Alt prefixes with Esc, which is how readline reads meta. */
export const alt = (text: string): Uint8Array => {
  const body = bytes(text)
  const out = new Uint8Array(body.length + 1)
  out[0] = 0x1b
  out.set(body, 1)
  return out
}

/**
 * Wrapping a paste tells the receiver it is pasted rather than typed, so a
 * shell does not run each line as it arrives.
 */
export const paste = (text: string, modes: Modes): Uint8Array =>
  modes.bracketedPaste ? bytes(`\x1b[200~${text}\x1b[201~`) : bytes(text)

/** Maps a browser keydown. Returns null for keys that are ordinary text. */
export const fromKeyboard = (e: KeyboardEvent, modes: Modes): Uint8Array | null => {
  if (e.key === "Tab") return special(e.shiftKey ? "ShiftTab" : "Tab", modes)

  const named = special(e.key, modes)
  if (named) return named

  if (e.ctrlKey && !e.altKey && e.key.length === 1) return control(e.key)
  if (e.altKey && !e.ctrlKey && e.key.length === 1) return alt(e.key)
  if (e.metaKey) return null // leave browser shortcuts alone
  if (e.key.length === 1) return bytes(e.key)
  return null
}
