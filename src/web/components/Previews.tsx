import { ExternalLink, Globe, Link2, Loader2, Lock, Plus, X } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"

/**
 * The ports on a box, and who can see them.
 *
 * This is the answer to "I want to look at what the agent built". A run can be
 * read from its diff and its tests; a website cannot — it has to be used, in a
 * browser, by a person. Every other way of doing that either puts unfinished
 * work on the public internet or ties it to a laptop that has to stay awake.
 *
 * Private is the default and is the one that matters: the URL is not a
 * credential, and reaching it needs a browser this account has admitted. `link`
 * is for showing somebody without an account, which is why it always has an end
 * date attached.
 */
export const Previews: React.FC<{ boxId: number; ready: boolean }> = ({ boxId, ready }) => {
  const [previews, setPreviews] = useState<api.Preview[]>([])
  const [adding, setAdding] = useState(false)
  const [port, setPort] = useState("3000")
  const [shareable, setShareable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      setPreviews(await api.listPreviews(boxId))
    } catch {
      // A box that is still coming up has no previews and no opinion about it.
    }
  }, [boxId])

  useEffect(() => {
    if (ready) void load()
  }, [ready, load])

  const add = async () => {
    const value = Number(port)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      setError("Ports are 1 to 65535.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const made = await api.createPreview(boxId, {
        port: value,
        audience: shareable ? "link" : "private",
      })
      setPreviews(list => [made, ...list.filter(p => p.id !== made.id)])
      setAdding(false)
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: number) => {
    setPreviews(list => list.filter(p => p.id !== id))
    try {
      await api.revokePreview(id)
    } catch {
      void load()
    }
  }

  if (!ready) return null

  return (
    <div className="sidebar-section">
      <div className="sidebar-head">
        <span>Ports</span>
        <button type="button" className="icon" onClick={() => setAdding(a => !a)} title="Preview a port">
          <Plus size={15} />
        </button>
      </div>

      {adding && (
        <div className="port-form">
          <input
            type="text"
            inputMode="numeric"
            value={port}
            onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="3000"
            aria-label="Port"
          />
          {/* Said as a consequence rather than as a setting. "Audience: link"
              is a field; "anyone with the link" is what actually happens. */}
          <label className="port-check">
            <input type="checkbox" checked={shareable} onChange={e => setShareable(e.target.checked)} />
            Anyone with the link, for a day
          </label>
          <button type="button" onClick={add} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : "Preview it"}
          </button>
        </div>
      )}

      {error && <p className="port-error">{error}</p>}
      {previews.length === 0 && !adding && (
        <p className="muted small pad">Nothing published. Add a port to open a dev server in a browser.</p>
      )}

      {previews.map(p => (
        <div key={p.id} className="row">
          <a className="row-main" href={p.url} target="_blank" rel="noreferrer">
            {p.audience === "link" ? (
              <Link2 size={12} className="pending" />
            ) : (
              <Lock size={12} className="ok" />
            )}
            <span className="row-body">
              <strong>:{p.port}</strong>
              <span className="muted small">
                {p.audience === "link" ? "anyone with the link" : "only you"}
              </span>
            </span>
            <ExternalLink size={12} className="dim" />
          </a>
          <button
            type="button"
            className="icon dim"
            title="Copy the link"
            aria-label={`Copy the link to port ${p.port}`}
            onClick={async () => {
              await navigator.clipboard.writeText(p.url).catch(() => {})
              setCopied(p.id)
              setTimeout(() => setCopied(c => (c === p.id ? null : c)), 1200)
            }}
          >
            {copied === p.id ? <Globe size={13} className="ok" /> : <Link2 size={13} />}
          </button>
          <button
            type="button"
            className="icon dim"
            title="Stop publishing this port"
            aria-label={`Stop publishing port ${p.port}`}
            onClick={() => revoke(p.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
