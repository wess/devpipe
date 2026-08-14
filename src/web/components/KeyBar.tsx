import type React from "react"

/**
 * The row above the software keyboard.
 *
 * A phone keyboard offers no Esc, no Ctrl, no Tab and no arrows, so without
 * this a coding agent's TUI cannot be interrupted, cannot cycle permission
 * modes, and cannot scroll its own history. The iOS client has carried one of
 * these from the start; this is the same set of keys in the same order, because
 * the two clients are the same product and muscle memory should carry across.
 *
 * Ordered by how often an agent CLI needs them, not by how a terminal app
 * usually lays this out.
 */
export type BarKey =
  | { label: string; key: string }
  /** Latches instead of sending: a modifier you must hold is unusable here. */
  | { label: string; latch: "ctrl" | "alt" }
  | { label: string; action: "paste" }

export const KEYS: BarKey[] = [
  { label: "esc", key: "Escape" },
  { label: "paste", action: "paste" },
  { label: "ctrl", latch: "ctrl" },
  { label: "alt", latch: "alt" },
  { label: "tab", key: "Tab" },
  { label: "⇧tab", key: "ShiftTab" },
  { label: "←", key: "ArrowLeft" },
  { label: "↓", key: "ArrowDown" },
  { label: "↑", key: "ArrowUp" },
  { label: "→", key: "ArrowRight" },
  { label: "home", key: "Home" },
  { label: "end", key: "End" },
  { label: "pgup", key: "PageUp" },
  { label: "pgdn", key: "PageDown" },
]

export const KeyBar: React.FC<{
  ctrl: boolean
  alt: boolean
  onKey: (name: string) => void
  onLatch: (which: "ctrl" | "alt") => void
  onPaste: () => void
}> = ({ ctrl, alt, onKey, onLatch, onPaste }) => (
  <div className="keybar" role="toolbar" aria-label="Terminal keys">
    {KEYS.map(item => {
      const latched = "latch" in item && (item.latch === "ctrl" ? ctrl : alt)
      return (
        <button
          key={item.label}
          type="button"
          className={latched ? "keybar-key on" : "keybar-key"}
          aria-pressed={"latch" in item ? latched : undefined}
          // Pointer-down rather than click, and the default suppressed: a
          // button taking focus closes the software keyboard, and a keyboard
          // that shuts every time you reach for Esc is worse than no bar.
          onPointerDown={e => {
            e.preventDefault()
            if ("latch" in item) onLatch(item.latch)
            else if ("action" in item) onPaste()
            else onKey(item.key)
          }}
        >
          {item.label}
        </button>
      )
    })}
  </div>
)
