/**
 * Resolves the colour tags the emulator emits into actual RGB.
 *
 * A deliberate copy of the iOS client's `Palette.swift`, down to the values.
 * The core ships `Default` / `Indexed` / `Rgb` rather than baking a theme in,
 * so each client decides what those mean — and the two clients have to decide
 * the same thing or the same session looks like two different products.
 */

export const BACKGROUND = "#12141a"
export const FOREGROUND = "#d6dae2"
export const CURSOR = "#6fb1fb"

const named = [
  "#212530",
  "#f06170",
  "#8ecc78",
  "#e6bf6b",
  "#70b0fa",
  "#c791f0",
  "#6bcccc",
  "#d6dae2",
  "#596170",
  "#fa828c",
  "#a8e091",
  "#fad985",
  "#8fc7ff",
  "#deadfa",
  "#87e3e3",
  "#fafcff",
]

const table: string[] = (() => {
  const out = [...named]
  const steps = [0, 95, 135, 175, 215, 255]
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        out.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`)
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    out.push(`rgb(${v},${v},${v})`)
  }
  return out
})()

/** `packed` is `tag << 24 | payload` — see the core's `pack_color`. */
export const resolve = (packed: number, isForeground: boolean): string => {
  switch (packed >>> 24) {
    case 0:
      return isForeground ? FOREGROUND : BACKGROUND
    case 1:
      return table[packed & 0xff] ?? FOREGROUND
    default:
      return `rgb(${(packed >> 16) & 0xff},${(packed >> 8) & 0xff},${packed & 0xff})`
  }
}

/** A default background needs no fill — the canvas is already that colour. */
export const isDefaultBackground = (packed: number) => packed === 0

/**
 * The wash drawn over selected cells.
 *
 * Translucent on purpose: the alternative is re-inking each cell with a
 * selection foreground and background, which means duplicating every colour
 * rule the renderer already has and keeping the copy in step with it.
 */
export const SELECTION = "rgba(255, 180, 84, 0.28)"
