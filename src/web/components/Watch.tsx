import { Eye, Keyboard, Loader2 } from "lucide-react"
import type React from "react"
import { useEffect, useState } from "react"
import * as api from "../api.ts"
import { loadVt } from "../terminal/vt.ts"
import { TerminalView } from "./TerminalView.tsx"

/**
 * Somebody else's terminal, opened from a link.
 *
 * No account, no box, nothing in localStorage: the token in the URL is the
 * whole credential, and it reaches exactly one session on one machine until the
 * person who made it says otherwise. That is the difference between this and a
 * screen share — the text is real text, it selects and copies, and it stays
 * legible on a phone.
 *
 * The socket goes to the control plane rather than to the box. `readOnly` here
 * is a courtesy to the guest, so that watching does not feel like a terminal
 * that has hung; the rule is enforced on the hop that holds the credential.
 */
export const Watch: React.FC<{ token: string }> = ({ token }) => {
  const [share, setShare] = useState<{ mode: "watch" | "control"; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState("connecting")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [found] = await Promise.all([api.describeShare(token), loadVt()])
        if (!cancelled) {
          setShare(found)
          setReady(true)
        }
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message ?? err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  if (error) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="brand">
            <Eye size={18} />
            <span>Devpipe</span>
          </div>
          <p className="note bad">{error}</p>
          <p className="muted small">Links to a terminal are made by the person whose machine it is, and they end.</p>
        </div>
      </div>
    )
  }

  if (!ready || !share) {
    return (
      <div className="gate">
        <Loader2 className="spin" size={20} />
      </div>
    )
  }

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">
          {share.mode === "control" ? <Keyboard size={16} /> : <Eye size={16} />}
          <span>{share.label || "Shared terminal"}</span>
        </span>
        <span className="grow" />
        {/* Said plainly and left on screen. A watcher who does not know they
            are a watcher reports a broken keyboard. */}
        <span className="muted small">{share.mode === "control" ? "you can type" : "watching — read only"}</span>
        <span className="muted small">{status}</span>
      </nav>
      <div className="pane">
        <TerminalView
          url=""
          token=""
          sessionId=""
          endpoint={api.shareSocketUrl(token)}
          readOnly={share.mode !== "control"}
          onStatus={setStatus}
        />
      </div>
    </div>
  )
}
