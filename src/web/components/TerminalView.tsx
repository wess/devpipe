import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { alt, control, special } from "../terminal/keys.ts"
import { DEFAULT_FONT_SIZE, gridFor } from "../terminal/metrics.ts"
import { mouseMotionReport, mouseReport, wheelAction } from "../terminal/mouse.ts"
import { Renderer } from "../terminal/render.ts"
import { Session } from "../terminal/session.ts"
import { classify, type Gesture, LONG_PRESS_MS, scrollLines, type Touch, wasTap } from "../terminal/touch.ts"
import { KeyBar } from "./KeyBar.tsx"

/** What `keyModes()` answers when there is no emulator yet. */
const NO_MODES = { cursorApp: false, keypadApp: false, bracketedPaste: false }

/** Alt is Esc-then-the-bytes, which is how readline reads meta. */
const withEsc = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(data.length + 1)
  out[0] = 0x1b
  out.set(data, 1)
  return out
}

/**
 * A live terminal.
 *
 * Owns the canvas, the emulator, and the socket. The layout it sits in — a
 * column of sessions on the left, this filling the rest — is the same on the
 * iPad, because it is the same product and switching device should not mean
 * relearning where anything is.
 *
 * Input does not come from the canvas. A canvas cannot raise a software
 * keyboard however focusable it is made, so on a phone or a tablet this was a
 * terminal with no way to type into it — the client was a desktop client that
 * happened to reflow. Keys arrive through an offscreen textarea instead, which
 * is also what makes an IME work: composing text has to live in a real editable
 * field until it is committed.
 */
export const TerminalView: React.FC<{
  url: string
  /**
   * The attach credential, or a way to mint one. A function in every real
   * case: what the control plane issues lasts two minutes, so it has to be
   * fetched per connection attempt rather than held. Must be stable across
   * renders — this is in the effect's dependencies, and a fresh closure each
   * render tears the terminal down and rebuilds it.
   */
  token: string | (() => Promise<string>)
  sessionId: string
  fontSize?: number
  onStatus?: (s: string) => void
  /** The grid actually in use, whenever it changes. */
  onResize?: (cols: number, rows: number) => void
  /**
   * A socket URL to use verbatim, for a session reached through the control
   * plane rather than on the box — which is how a shared session is watched.
   */
  endpoint?: string
  /** Watching somebody else's terminal: no input, no resize, no key bar. */
  readOnly?: boolean
}> = ({ url, token, sessionId, fontSize = DEFAULT_FONT_SIZE, onStatus, onResize, endpoint, readOnly = false }) => {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const gridRef = useRef({ cols: 0, rows: 0 })
  /** The last completed selection, so copy has something to read. */
  const selectedRef = useRef("")
  const [linkUnder, setLinkUnder] = useState<string | null>(null)

  // A finger, not a mouse. Decides whether the key row is worth the space:
  // a desktop keyboard already has Esc and Ctrl, and a bar of them there is
  // just a strip of the terminal given away.
  const [coarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
  )
  /** Ctrl and Alt latch, because a modifier you have to hold needs two hands. */
  const [latch, setLatch] = useState({ ctrl: false, alt: false })
  const latchRef = useRef(latch)
  latchRef.current = latch
  /** Something was selected by finger, so there is something to copy. */
  const [touchSelection, setTouchSelection] = useState(false)
  /** How much of the window the software keyboard is covering. */
  const [keyboardInset, setKeyboardInset] = useState(0)

  const clearLatch = useCallback(() => {
    if (latchRef.current.ctrl || latchRef.current.alt) setLatch({ ctrl: false, alt: false })
  }, [])

  /** Text the user typed, with whatever the bar has latched applied to it. */
  const sendText = useCallback(
    (text: string) => {
      const session = sessionRef.current
      if (!session || !text) return
      const { ctrl, altKey } = { ctrl: latchRef.current.ctrl, altKey: latchRef.current.alt }
      let out: Uint8Array | null = null
      if (ctrl && text.length === 1) out = control(text)
      if (out && altKey) out = withEsc(out)
      if (!out && altKey && text.length === 1) out = alt(text)
      if (!out) out = new TextEncoder().encode(text)
      session.term?.scrollToBottom()
      session.send(out)
      clearLatch()
    },
    [clearLatch],
  )

  /** A named key — from the bar, or from a soft keyboard's editing intent. */
  const sendSpecial = useCallback(
    (name: string) => {
      const session = sessionRef.current
      if (!session) return
      const out = special(name, session.term?.keyModes() ?? NO_MODES)
      if (!out) return
      session.term?.scrollToBottom()
      session.send(latchRef.current.alt ? withEsc(out) : out)
      clearLatch()
    },
    [clearLatch],
  )

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
    const session = new Session(url, token, sessionId, start.cols, start.rows, { endpoint, readOnly })
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

    // Only where a keyboard is already out. Focusing on a phone either does
    // nothing — browsers refuse it outside a gesture — or throws the software
    // keyboard up over a terminal nobody has asked to type into yet.
    if (!coarse) inputRef.current?.focus()

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

    // ---- touch ------------------------------------------------------------
    //
    // A finger scrolls where a mouse selects. There is no wheel on a phone, so
    // a drag that selected text would leave scrollback unreachable; selection
    // moves to long press, which is where every other app on the device puts
    // it. `touch.ts` owns the arithmetic that decides which is which.
    let began: Touch | null = null
    let gesture: Gesture = { kind: "pending" }
    let lastY = 0
    /** Sub-cell pixels left over, carried so a slow drag still moves. */
    let carry = 0
    let press: ReturnType<typeof setTimeout> | undefined

    const spot = (t: globalThis.Touch) => {
      const rect = canvas.getBoundingClientRect()
      return { x: t.clientX - rect.left, y: t.clientY - rect.top }
    }
    const cellAt = (x: number, y: number) => {
      const col = Math.max(0, Math.min(renderer.cols() - 1, Math.floor(x / renderer.cellWidth)))
      const row = Math.max(0, Math.min(renderer.rows() - 1, Math.floor(y / renderer.cellHeight)))
      return { col, row, line: row - (session.term?.displayOffset() ?? 0) }
    }

    const onTouchStart = (e: TouchEvent) => {
      // Two fingers are the browser's — pinch to zoom the page still works.
      if (e.touches.length !== 1 || !e.touches[0]) return
      const p = spot(e.touches[0])
      began = { x: p.x, y: p.y, at: performance.now() }
      gesture = { kind: "pending" }
      lastY = p.y
      carry = 0
      // On a timer rather than on the next move: the ordinary long press does
      // not move at all, so waiting for `touchmove` to notice it never fires.
      press = setTimeout(() => {
        if (!began || gesture.kind !== "pending") return
        gesture = { kind: "select" }
        const cell = cellAt(began.x, began.y)
        // Word mode, matching what a long press selects everywhere else.
        session.term?.selectionStart(cell.line, cell.col, 1)
        renderer.invalidate()
        navigator.vibrate?.(10)
      }, LONG_PRESS_MS)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!began || e.touches.length !== 1 || !e.touches[0]) return
      const p = spot(e.touches[0])
      gesture = classify(gesture, began, p.x, p.y, performance.now() - began.at)
      if (gesture.kind === "pending") return
      clearTimeout(press)
      e.preventDefault()
      if (gesture.kind === "scroll") {
        // A finger dragging down pulls the content down, which is backwards
        // through history — the page moves with the finger, not against it.
        const moved = scrollLines(p.y - lastY + carry, renderer.cellHeight)
        carry = moved.remainder
        lastY = p.y
        if (moved.lines) session.scrollLines(moved.lines)
        return
      }
      const cell = cellAt(p.x, p.y)
      session.term?.selectionUpdate(cell.line, cell.col)
      renderer.invalidate()
    }

    const onTouchEnd = (e: TouchEvent) => {
      clearTimeout(press)
      if (!began) return
      const t = e.changedTouches[0]
      const p = t ? spot(t) : { x: began.x, y: began.y }
      if (gesture.kind === "select") {
        // Kept rather than cleared: the selection has to survive the finger
        // lifting or there is nothing left to copy.
        selectedRef.current = session.term?.selectionText() ?? ""
        setTouchSelection(selectedRef.current.length > 0)
      } else if (wasTap(gesture, began, p.x, p.y, performance.now() - began.at)) {
        // The tap that raises the keyboard, which is the single thing a touch
        // terminal cannot do without.
        inputRef.current?.focus()
        setTouchSelection(false)
      }
      began = null
      gesture = { kind: "pending" }
    }

    canvas.addEventListener("touchstart", onTouchStart, { passive: true })
    // Not passive: a scroll of the terminal that also scrolls the page is
    // unusable, and only a non-passive listener may say so.
    canvas.addEventListener("touchmove", onTouchMove, { passive: false })
    canvas.addEventListener("touchend", onTouchEnd)
    canvas.addEventListener("touchcancel", onTouchEnd)

    const observer = new ResizeObserver(fit)
    observer.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(press)
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      canvas.removeEventListener("touchstart", onTouchStart)
      canvas.removeEventListener("touchmove", onTouchMove)
      canvas.removeEventListener("touchend", onTouchEnd)
      canvas.removeEventListener("touchcancel", onTouchEnd)
      observer.disconnect()
      session.stop()
      sessionRef.current = null
      rendererRef.current = null
    }
    // `coarse` is settled once at mount and never changes, so listing it costs
    // nothing — but leaving it out is the kind of omission that is correct
    // today and quietly wrong the moment somebody makes it stateful.
  }, [url, token, sessionId, fontSize, coarse, endpoint, readOnly])

  // What the software keyboard is covering.
  //
  // Opening it shrinks the visual viewport and leaves the layout viewport
  // alone, so without this the terminal keeps its full height and the prompt —
  // the one row that matters — sits behind the keyboard.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const measure = () => {
      setKeyboardInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    }
    measure()
    vv.addEventListener("resize", measure)
    vv.addEventListener("scroll", measure)
    return () => {
      vv.removeEventListener("resize", measure)
      vv.removeEventListener("scroll", measure)
    }
  }, [])

  // Text from a software keyboard, and from an IME.
  //
  // Bound natively rather than through React's `onBeforeInput`, which does not
  // carry `inputType` — and `inputType` is the only thing that distinguishes a
  // soft keyboard's backspace from the letter it just sent. Android reports
  // almost every key as `Unidentified` with keyCode 229, so `keydown` alone
  // sees nothing typeable at all.
  useEffect(() => {
    const field = inputRef.current
    if (!field) return
    let composing = false

    const onBeforeInput = (e: InputEvent) => {
      // An IME owns the field until it commits: taking the text away mid
      // composition leaves the candidate window with nothing to revise.
      if (composing || e.isComposing) return
      e.preventDefault()
      switch (e.inputType) {
        case "insertText":
        case "insertFromPaste":
        case "insertReplacementText":
          if (e.data) sendText(e.data)
          break
        case "insertLineBreak":
        case "insertParagraph":
          sendSpecial("Enter")
          break
        case "deleteContentBackward":
        case "deleteWordBackward":
          sendSpecial("Backspace")
          break
        case "deleteContentForward":
        case "deleteWordForward":
          sendSpecial("Delete")
          break
      }
    }
    const onCompositionStart = () => {
      composing = true
    }
    const onCompositionEnd = (e: CompositionEvent) => {
      composing = false
      if (e.data) sendText(e.data)
      field.value = ""
    }

    field.addEventListener("beforeinput", onBeforeInput)
    field.addEventListener("compositionstart", onCompositionStart)
    field.addEventListener("compositionend", onCompositionEnd)
    return () => {
      field.removeEventListener("beforeinput", onBeforeInput)
      field.removeEventListener("compositionstart", onCompositionStart)
      field.removeEventListener("compositionend", onCompositionEnd)
    }
  }, [sendText, sendSpecial])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A composing IME, or Android's placeholder for "ask beforeinput instead".
      // Reading either as a keystroke sends the wrong bytes and, worse, cancels
      // the composition that was about to produce the right ones.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
      // A latched modifier applies to the next key from anywhere, including a
      // hardware keyboard paired with a tablet — which is the ordinary way an
      // iPad is used for this, and where the bar is still the only Esc.
      if ((latchRef.current.ctrl || latchRef.current.alt) && e.key.length === 1) {
        e.preventDefault()
        sendText(e.key)
        return
      }
      sessionRef.current?.key(e.nativeEvent)
    },
    [sendText],
  )

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData("text")
    if (text) sessionRef.current?.pasteText(text)
  }, [])

  /** The bar's paste, which has no clipboard event to read. */
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) sessionRef.current?.pasteText(text)
    } catch {
      // Denied, or a browser that will not read the clipboard without a
      // permission prompt. Nothing useful to say; the key simply does nothing.
    }
    inputRef.current?.focus()
  }, [])

  const copySelection = useCallback(async () => {
    const text = sessionRef.current?.term?.selectionText() || selectedRef.current
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* denied */
    }
    setTouchSelection(false)
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
      // The field, not the canvas: focus is what raises a software keyboard,
      // and a canvas cannot raise one however focusable it is made.
      inputRef.current?.focus()
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
    // The inset lifts the whole terminal clear of the software keyboard. The
    // ResizeObserver inside is watching `.term-body`, so the grid refits to
    // what is left rather than keeping rows nobody can see.
    <div className="term-wrap" style={keyboardInset ? { marginBottom: keyboardInset } : undefined}>
      <div className="term-body" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="term-canvas"
          style={{ cursor: linkUnder ? "pointer" : "text" }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setLinkUnder(null)}
          onClick={onClick}
        />
        {linkUnder && <div className="term-link">{linkUnder}</div>}
        {touchSelection && (
          <button type="button" className="term-copy" onPointerDown={e => e.preventDefault()} onClick={copySelection}>
            copy
          </button>
        )}
      </div>
      {/*
        Offscreen, but genuinely focusable and genuinely editable — `hidden`
        or `display:none` would make it neither, and then nothing on a phone
        can type. Autocorrect and capitalisation are off because this is a
        command line: "ls" is not a typo and must not become "Is".
      */}
      <textarea
        ref={inputRef}
        className="term-input"
        aria-label="Terminal input"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {coarse && !readOnly && (
        <KeyBar
          ctrl={latch.ctrl}
          alt={latch.alt}
          onKey={sendSpecial}
          onLatch={which => setLatch(prev => ({ ...prev, [which]: !prev[which] }))}
          onPaste={pasteFromClipboard}
        />
      )}
    </div>
  )
}
