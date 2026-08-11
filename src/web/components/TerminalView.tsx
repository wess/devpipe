import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { DEFAULT_FONT_SIZE, gridFor } from "../terminal/metrics.ts"
import { mouseMotionReport, mouseReport, wheelAction } from "../terminal/mouse.ts"
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
  /** The last completed selection, so copy has something to read. */
  const selectedRef = useRef("")
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

    session.onStatus = s => {
      // An attach replaces the whole screen: the daemon replays the session's
      // current contents, which has nothing to do with whatever this canvas
      // was showing. Without repainting all of it, the replay lands in the
      // emulator and stays invisible — the terminal reads as empty until a
      // keystroke happens to dirty a row, which is exactly how reattaching
      // looked like the box had lost the session.
      if (s === "attached" || s === "connected" || s === "caught up") renderer.invalidate()
      statusRef.current?.(s)
    }
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

    /** Pointer position as a cell, and as an absolute content line. */
    const at = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const col = Math.max(0, Math.min(renderer.cols() - 1, Math.floor((e.clientX - rect.left) / renderer.cellWidth)))
      const row = Math.max(0, Math.min(renderer.rows() - 1, Math.floor((e.clientY - rect.top) / renderer.cellHeight)))
      // Absolute content coordinates: row 0 of the viewport is `-offset` when
      // the view is scrolled back, so a selection made in history stays on the
      // text it was made on rather than on whatever later scrolls into place.
      return { col, row, line: row - (session.term?.displayOffset() ?? 0) }
    }

    // Bound natively rather than through React's `onWheel`: React attaches
    // wheel listeners passively, and a passive listener cannot preventDefault,
    // so every scroll of the terminal would also scroll the page.
    const onWheel = (e: WheelEvent) => {
      const term = session.term
      if (!term) return
      const lines = renderer.linesForWheel(e.deltaY, e.deltaMode)
      const { col, row } = at(e)
      const action = wheelAction(
        term.pointerModes(),
        lines,
        col,
        row,
        term.scrollbackLength() > 0,
        term.keyModes().cursorApp,
      )
      // Only the page case leaves the gesture alone. Everything else is the
      // terminal's, and letting it bubble scrolls the document underneath a
      // terminal that just handled it.
      if (action.kind === "page") return
      e.preventDefault()
      if (action.kind === "scrollback") session.scrollLines(-action.lines)
      else session.send(action.bytes)
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })

    // Selection and mouse reporting share the pointer, so they are decided in
    // one place: a program that has asked for the mouse gets it, and otherwise
    // a drag selects text. Holding shift forces selection either way, which is
    // the escape hatch every terminal offers for copying out of a full-screen
    // program.
    let dragging = false
    const onMouseDown = (e: MouseEvent) => {
      const term = session.term
      if (!term || e.button > 2) return
      const { col, row, line } = at(e)
      const modes = term.pointerModes()
      if (modes.reportClick && !e.shiftKey) {
        const bytes = mouseReport(modes, e.button, col, row, true, {
          shift: e.shiftKey,
          alt: e.altKey,
          ctrl: e.ctrlKey,
        })
        if (bytes) {
          e.preventDefault()
          session.send(bytes)
        }
        return
      }
      if (e.button !== 0) return
      dragging = true
      // One click is a cell, two is a word, three is the logical line — which
      // follows soft wraps, so a wrapped command copies back as one command.
      const mode = e.detail >= 3 ? 2 : e.detail === 2 ? 1 : 0
      term.selectionStart(line, col, mode as 0 | 1 | 2)
      renderer.invalidate()
    }

    const onMouseMove = (e: MouseEvent) => {
      const term = session.term
      if (!term) return
      const { col, row, line } = at(e)
      if (dragging) {
        term.selectionUpdate(line, col)
        renderer.invalidate()
        return
      }
      const modes = term.pointerModes()
      const bytes = mouseMotionReport(modes, e.buttons ? 0 : 3, col, row, e.buttons !== 0)
      if (bytes) session.send(bytes)
    }

    const onMouseUp = (e: MouseEvent) => {
      const term = session.term
      if (!term) return
      const { col, row } = at(e)
      const modes = term.pointerModes()
      if (dragging) {
        dragging = false
        // Kept, not cleared: the selection has to survive the mouse coming up
        // or there is nothing left to copy.
        selectedRef.current = term.selectionText()
        return
      }
      if (modes.reportClick && !e.shiftKey) {
        const bytes = mouseReport(modes, e.button, col, row, false, {
          shift: e.shiftKey,
          alt: e.altKey,
          ctrl: e.ctrlKey,
        })
        if (bytes) session.send(bytes)
      }
    }

    canvas.addEventListener("mousedown", onMouseDown)
    // On window, so a drag that leaves the canvas still finishes rather than
    // leaving the selection stuck to the pointer.
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)

    const observer = new ResizeObserver(fit)
    observer.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      observer.disconnect()
      session.stop()
      sessionRef.current = null
      rendererRef.current = null
    }
  }, [url, token, sessionId, fontSize])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const key = e.key.toLowerCase()
    if (e.metaKey || e.ctrlKey) {
      // Copy is ours to serve. The grid is painted to a canvas, so there is no
      // document selection for the browser to copy — `window.getSelection()`
      // is always empty here, which is why the old passthrough could never
      // fire and no terminal on this client had ever been copyable.
      if (key === "c") {
        const text = sessionRef.current?.term?.selectionText() || selectedRef.current
        if (text) {
          e.preventDefault()
          void navigator.clipboard.writeText(text)
          return
        }
        // Nothing selected: ctrl-C is an interrupt and has to reach the pty.
        // Cmd-C is not, so it is left alone.
        if (e.metaKey) return
      }
      // Paste arrives as a paste event, not as a keystroke.
      if (key === "v") return
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
