import { fromKeyboard, paste } from "./keys.ts"
import { Terminal } from "./vt.ts"

/**
 * One attached terminal: the emulator, the socket, and the reconnection.
 *
 * A direct mirror of the iOS `WebSocketSource`, including why it reconnects on
 * its own. A browser tab that has been backgrounded gets its socket dropped
 * the same way a suspended app does, and without reconnection the persistence
 * the daemon provides is invisible — the session really is still running, but
 * the only way to see it again is a page reload.
 */
export class Session {
  term: Terminal | null = null
  status = "connecting"

  onBytes?: () => void
  onStatus?: (status: string) => void

  private socket: WebSocket | null = null
  private finished = false
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private pendingSize: { cols: number; rows: number } | null = null

  /**
   * `opts.endpoint` replaces the composed URL entirely, and `opts.readOnly`
   * makes this a watcher.
   *
   * Both exist for shared sessions. A guest's socket does not go to the box —
   * it terminates on the control plane, which holds the box's credential and
   * copies frames, so the URL is a different shape and there is no token to
   * put in it. Read-only is enforced there too; this half is so that a watcher
   * does not type into a terminal and watch nothing happen, which reads as a
   * hung session rather than as a permission.
   */
  constructor(
    private url: string,
    private token: string,
    private sessionId: string,
    cols: number,
    rows: number,
    private opts: { endpoint?: string; readOnly?: boolean } = {},
  ) {
    this.term = new Terminal(cols, rows)
  }

  start() {
    this.finished = false
    this.attempt = 0
    this.connect()
    window.addEventListener("online", this.online)
    document.addEventListener("visibilitychange", this.visible)
  }

  stop() {
    this.finished = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.generation++
    window.removeEventListener("online", this.online)
    document.removeEventListener("visibilitychange", this.visible)
    this.socket?.close()
    this.socket = null
    this.term?.dispose()
    this.term = null
  }

  private online = () => this.reconnectNow("back online")
  private visible = () => {
    if (document.visibilityState === "visible") this.reconnectNow("back in view")
  }

  private setStatus(s: string) {
    this.status = s
    this.onStatus?.(s)
  }

  private connect() {
    if (this.finished) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const mine = ++this.generation

    // Whatever was here before is abandoned by the generation check the moment
    // `mine` is bumped, but abandoned is not closed. `reconnectNow` fires on
    // every visibilitychange and only skips a socket that is already OPEN, so a
    // tab switched away from and back to during a handshake left the previous
    // socket to finish connecting and then sit there — attached to the same pty,
    // holding a daemon slot, feeding a listener that discards it. Flip tabs
    // enough times on a slow link and it is one live socket per flip.
    this.socket?.close()

    // The token goes in the query string because a browser cannot set headers
    // on a WebSocket handshake. It is the box's own bearer, reaches only that
    // box, and the connection is TLS — but it does end up in the box's access
    // log, which is why it is not the account's credential.
    const socket = new WebSocket(
      this.opts.endpoint ??
        `${this.url}/v1/sessions/${encodeURIComponent(this.sessionId)}/attach?token=${encodeURIComponent(this.token)}`,
    )
    socket.binaryType = "arraybuffer"
    this.socket = socket

    socket.onopen = () => {
      if (mine !== this.generation) return
      this.attempt = 0
      this.setStatus("connected")
      if (this.pendingSize) this.resize(this.pendingSize.cols, this.pendingSize.rows)
    }
    socket.onmessage = ev => {
      if (mine !== this.generation) return
      if (typeof ev.data === "string") {
        this.control(ev.data)
        return
      }
      this.term?.feed(new Uint8Array(ev.data))
      const reply = this.term?.takeOutput()
      if (reply?.length) socket.send(reply)
      this.onBytes?.()
    }
    socket.onclose = () => {
      if (mine !== this.generation || this.finished) return
      this.setStatus("reconnecting")
      this.scheduleRetry()
    }
    socket.onerror = () => {
      if (mine !== this.generation || this.finished) return
      this.setStatus("reconnecting")
    }
  }

  private control(text: string) {
    try {
      const msg = JSON.parse(text)
      if (msg.t === "hello") {
        this.attempt = 0
        this.setStatus("attached")
        // A watcher takes the grid it is given. Sizing to the guest's own
        // viewport instead would reflow bytes that were laid out for somebody
        // else's terminal, which is not a smaller version of the session — it
        // is a different one, with the wrap points in the wrong places.
        if (this.opts.readOnly) {
          if (msg.cols > 0 && msg.rows > 0) this.term?.resize(msg.cols, msg.rows)
        } else if (this.pendingSize) {
          this.resize(this.pendingSize.cols, this.pendingSize.rows)
        }
      } else if (msg.t === "resync") {
        this.setStatus("caught up")
      } else if (msg.t === "exit") {
        // The child is gone, so retrying would attach to nothing.
        this.finished = true
        this.setStatus("session ended")
      }
    } catch {
      /* not ours */
    }
  }

  private reconnectNow(why: string) {
    if (this.finished || this.socket?.readyState === WebSocket.OPEN) return
    this.attempt = 0
    this.setStatus(`reconnecting — ${why}`)
    this.connect()
  }

  private scheduleRetry() {
    if (this.finished || this.retry) return
    this.attempt++
    // Caps at fifteen seconds. Jitter keeps a daemon restart from being met by
    // every client retrying in lockstep.
    const delay = Math.min(2 ** (this.attempt - 1) * 500, 15_000) + Math.random() * 400
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, delay)
  }

  send(data: Uint8Array) {
    if (this.opts.readOnly) return
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data)
  }

  /**
   * Move the view through history. Positive is back, negative is toward the
   * live bottom.
   *
   * The core does not follow the tail on its own: a view scrolled up stays on
   * the rows it was showing however much output arrives, and a view at the
   * bottom stays at the bottom. Nothing here has to arbitrate between the two.
   */
  scrollLines(delta: number) {
    this.term?.scroll(delta)
  }

  scrollToBottom() {
    this.term?.scrollToBottom()
  }

  key(e: KeyboardEvent) {
    const modes = this.term?.keyModes() ?? {
      cursorApp: false,
      keypadApp: false,
      bracketedPaste: false,
    }
    const out = fromKeyboard(e, modes)
    if (out) {
      // Typing is a statement of intent to use the live prompt. Sending a
      // keystroke and watching nothing happen because the view is still parked
      // in history reads as a hung terminal.
      //
      // Only for keys that produce bytes: pressing Shift or Cmd on its own
      // reaches here too, and losing your place in a log to a modifier you
      // pressed on the way to something else is worse than the hang it fixes.
      this.term?.scrollToBottom()
      e.preventDefault()
      this.send(out)
    }
  }

  pasteText(text: string) {
    this.term?.scrollToBottom()
    const modes = this.term?.keyModes() ?? {
      cursorApp: false,
      keypadApp: false,
      bracketedPaste: false,
    }
    this.send(paste(text, modes))
  }

  resize(cols: number, rows: number) {
    // A watcher never resizes anything. The pty belongs to whoever is working
    // in it, and a second pair of eyes reflowing their editor mid-sentence is
    // the one way a read-only share could still ruin somebody's afternoon.
    if (this.opts.readOnly) return
    // Remembered rather than only sent: a reconnect has to re-assert the size
    // or the pty keeps whatever it was created with.
    this.pendingSize = { cols, rows }
    this.term?.resize(cols, rows)
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: "resize", cols, rows }))
    }
  }
}
