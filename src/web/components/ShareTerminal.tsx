import { Check, Copy, Eye, Keyboard, Loader2, X } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"

/**
 * Letting somebody watch — or take — a terminal you have open.
 *
 * Watching is the default, and typing is the thing you have to reach for. A
 * guest who can type has a shell on the machine, because that is what a
 * terminal is; it must never be what somebody ends up granting by not reading
 * the dialog.
 *
 * The link appears exactly once. The server keeps only a hash of it, so there
 * is no second chance to copy it and nothing for a later database leak to
 * spend — which is worth the small annoyance of having to make a new one.
 */
export const ShareTerminal: React.FC<{
  boxId: number
  sessionId: string
  title: string
  onClose: () => void
}> = ({ boxId, sessionId, title, onClose }) => {
  const [existing, setExisting] = useState<api.Share[]>([])
  const [mode, setMode] = useState<"watch" | "control">("watch")
  const [hours, setHours] = useState("8")
  const [made, setMade] = useState<api.Share | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const all = await api.listShares(boxId)
      setExisting(all.filter(s => s.session_id === sessionId))
    } catch {
      // Nothing shared yet is the same shape as not being able to ask.
    }
  }, [boxId, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const share = await api.createShare(boxId, {
        session_id: sessionId,
        mode,
        label: title,
        hours: Number(hours) || 8,
      })
      setMade(share)
      void load()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="Close" onClick={onClose} />
      <dialog className="modal narrow" open aria-label={`Share ${title}`}>
        <header>
          <div>
            <h2>Share this terminal</h2>
            <p className="muted">{title}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="wizard-body">
          {made?.url ? (
            <>
              <p className="note">
                Copy this now — it is shown once and never again. Anyone holding it can{" "}
                {made.mode === "control" ? "type into" : "watch"} this terminal until it expires.
              </p>
              <div className="row-form">
                <input readOnly value={made.url} onFocus={e => e.currentTarget.select()} />
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(made.url ?? "").catch(() => {})
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1400)
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="choice-grid">
                <button
                  type="button"
                  className={`choice ${mode === "watch" ? "on" : ""}`}
                  onClick={() => setMode("watch")}
                >
                  <strong>
                    <Eye size={13} /> Watch
                  </strong>
                  <span className="muted small">They see everything. Nothing they press arrives.</span>
                </button>
                <button
                  type="button"
                  className={`choice ${mode === "control" ? "on" : ""}`}
                  onClick={() => setMode("control")}
                >
                  <strong>
                    <Keyboard size={13} /> Type
                  </strong>
                  <span className="muted small">A shell on this machine, for as long as the link lasts.</span>
                </button>
              </div>
              {mode === "control" && (
                <p className="note warn">
                  This is a shell on your box. Whoever opens it can run anything you can, including reading whatever the
                  box can read.
                </p>
              )}
              <label className="field">
                <span>Expires after</span>
                <select value={hours} onChange={e => setHours(e.target.value)}>
                  <option value="1">an hour</option>
                  <option value="8">eight hours</option>
                  <option value="24">a day</option>
                  <option value="168">a week</option>
                </select>
              </label>
              {error && <p className="note bad">{error}</p>}
            </>
          )}

          {existing.length > 0 && (
            <>
              <p className="muted small">
                {existing.length} link{existing.length === 1 ? "" : "s"} already open on this terminal.
              </p>
              {existing.map(s => (
                <div key={s.id} className="row">
                  <span className="row-main">
                    {s.mode === "control" ? <Keyboard size={12} /> : <Eye size={12} />}
                    <span className="row-body">
                      <strong>{s.mode === "control" ? "can type" : "watching"}</strong>
                      <span className="muted small">
                        opened {s.visits} time{s.visits === 1 ? "" : "s"}
                      </span>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="icon dim"
                    aria-label="Revoke this link"
                    title="Revoke"
                    onClick={async () => {
                      setExisting(list => list.filter(x => x.id !== s.id))
                      await api.revokeShare(s.id).catch(() => void load())
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        <footer>
          <button type="button" className="ghost" onClick={onClose}>
            {made ? "Done" : "Cancel"}
          </button>
          <span className="grow" />
          {!made && (
            <button type="button" onClick={create} disabled={busy}>
              {busy ? <Loader2 className="spin" size={14} /> : "Make a link"}
            </button>
          )}
        </footer>
      </dialog>
    </div>
  )
}
