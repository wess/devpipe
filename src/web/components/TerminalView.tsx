import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { DEFAULT_FONT_SIZE, gridFor } from "../terminal/metrics.ts"
import { Renderer } from "../terminal/render.ts"
import { Session } from "../terminal/session.ts"

/**
 * A live terminal.
 *
 * Owns the canvas, the emulator, and the socket. The layout it sits in — a
 * column of sessions on the left, this filling the rest — is the same on the
 * iPad, because it is the same product and switching device should not mean
 * relearning where anything is.
 */
export const TerminalView: React.FC<{
  url: string
  token: string
  sessionId: string
  fontSize?: number
  onStatus?: (s: string) => void
  /** The grid actually in use, whenever it changes. */
  onResize?: (cols: number, rows: number) => void
}> = ({ url, token, sessionId, fontSize = DEFAULT_FONT_SIZE, onStatus, onResize }) => {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const gridRef = useRef({ cols: 0, rows: 0 })
  const [linkUnder, setLinkUnder] = useState<string | null>(null)

  // Held in refs and kept out of the effect's dependencies. A caller that
  // passes an inline arrow — the ordinary thing to write — would otherwise
  // hand this a new function on every render, and the effect below tears down
  // the socket when it re-runs. That is a reconnect per keystroke of the
  // parent's state, and it looks like a flaky network rather than a bug here.
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus
  const resizeRef = useRef(onResize)
  resizeRef.current = onResize

  // One session per (box, sessionId). Re-running this on every render would
  // reconnect the socket constantly.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    // Built at the size it is about to be drawn at. `fit` re-asserts it to the
    // daemon a moment later regardless — reattaching to a session someone else
    // created means the pty's size is not ours to assume — but the emulator
    // never briefly exists at a width nothing on screen has.
    const first = wrap.getBoundingClientRect()
    const start = gridFor(first.width, first.height, fontSize)
    const session = new Session(url, token, sessionId, start.cols, start.rows)
    sessionRef.current = session
    const renderer = new Renderer(canvas, () => session.term, fontSize)
    rendererRef.current = renderer

    const fit = () => {
      const box = wrap.getBoundingClientRect()
      renderer.resizeCanvas(box.width, box.height)
      const { cols, rows } = renderer.gridFor(box.width, box.height)
      // Only when the grid actually changed. A window drag fires the observer
      // per animation frame, and every pixel of it would otherwise be a
      // TIOCSWINSZ and a SIGWINCH — a full-screen program redrawing itself
      // dozens of times through a gesture that moved it by one column.
      if (cols !== gridRef.current.cols || rows !== gridRef.current.rows) {
        gridRef.current = { cols, rows }
        session.resize(cols, rows)
        resizeRef.current?.(cols, rows)
      }
      renderer.invalidate()
    }
    fit()

    session.onStatus = s => statusRef.current?.(s)
    session.onBytes = () => {
      renderer.markDamage(session.term?.takeDamage() ?? "none")
    }
    session.start()

    let raf = 0
    const frame = () => {
      renderer.draw()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // Bound natively rather than through React's `onWheel`: React attaches
    // wheel listeners passively, and a passive listener cannot preventDefault,
    // so every scroll of the terminal would also scroll the page.
    const onWheel = (e: WheelEvent) => {
      const term = session.term
      // A full-screen program owns the viewport and keeps no scrollback; there
      // is nothing to scroll through, so let the gesture go to the page.
      if (!term || term.scrollbackLength() === 0) return
      e.preventDefault()
      const lines = renderer.linesForWheel(e.deltaY, e.deltaMode)
      if (lines) session.scrollLines(-lines)
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })

    const observer = new ResizeObserver(fit)
    observer.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener("wheel", onWheel)
      observer.disconnect()
      session.stop()
      sessionRef.current = null
      rendererRef.current = null
    }
  }, [url, token, sessionId, fontSize])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Let the browser keep copy and paste; everything else belongs to the pty.
    if ((e.metaKey || e.ctrlKey) && ["c", "v", "a"].includes(e.key.toLowerCase())) {
      if (e.key.toLowerCase() === "c" && window.getSelection()?.toString()) return
      if (e.key.toLowerCase() === "v") return
    }
    sessionRef.current?.key(e.nativeEvent)
  }, [])

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData("text")
    if (text) sessionRef.current?.pasteText(text)
  }, [])

  // A URL under the pointer becomes clickable. This is what makes signing in
  // to an agent CLI workable: the OAuth prompt prints a link several hundred
  // characters long, and the alternative is transcribing it.
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const renderer = rendererRef.current
    const term = sessionRef.current?.term
    if (!renderer || !term) return
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    const col = Math.floor((e.clientX - rect.left) / renderer.cellWidth)
    const row = Math.floor((e.clientY - rect.top) / renderer.cellHeight)
    setLinkUnder(term.linkAt(row, col)?.url ?? null)
  }, [])

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current
      canvas?.focus()
      if (!linkUnder) return
      const renderer = rendererRef.current
      const term = sessionRef.current?.term
      if (!renderer || !term) return
      const rect = (e.target as HTMLElement).getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left) / renderer.cellWidth)
      const row = Math.floor((e.clientY - rect.top) / renderer.cellHeight)
      const hit = term.linkAt(row, col)
      if (hit) window.open(hit.url, "_blank", "noopener,noreferrer")
    },
    [linkUnder],
  )

  return (
    <div className="term-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="term-canvas"
        tabIndex={0}
        style={{ cursor: linkUnder ? "pointer" : "text" }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setLinkUnder(null)}
        onClick={onClick}
      />
      {linkUnder && <div className="term-link">{linkUnder}</div>}
    </div>
  )
}
