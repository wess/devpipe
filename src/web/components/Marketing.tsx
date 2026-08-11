import { Check, Download, Loader2, Send, Trash2 } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"
import { save } from "../download.ts"
import { when } from "../format.ts"

type Note = { kind: "ok" | "bad"; text: string }

/**
 * Claimed names, and writing to the people who claimed them.
 *
 * A send cannot be recalled, so composing and sending are separate acts: a
 * broadcast is saved as a draft, previewed to your own address, and only then
 * sent — with the subject typed back to confirm. A single button between a
 * half-written thought and everyone's inbox is not enough.
 */
export const Marketing: React.FC<{ onNote: (n: Note) => void }> = ({ onNote }) => {
  const [claims, setClaims] = useState<Awaited<ReturnType<typeof api.adminClaims>>>([])
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminBroadcasts>> | null>(null)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [audience, setAudience] = useState("claims")
  const [confirming, setConfirming] = useState<number | null>(null)
  const [confirmText, setConfirmText] = useState("")
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sending, setSending] = useState(false)

  const refresh = useCallback(() => {
    void api
      .adminClaims()
      .then(setClaims)
      .catch(() => {})
    void api
      .adminBroadcasts()
      .then(setData)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const compose = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.adminCreateBroadcast(subject, body, audience)
      setSubject("")
      setBody("")
      onNote({ kind: "ok", text: "Saved as a draft. Preview it before sending." })
      refresh()
    } catch (err: any) {
      onNote({ kind: "bad", text: String(err.message) })
    }
    setBusy(false)
  }

  const counts = data?.counts ?? {}

  return (
    <>
      <section className="card">
        <h2>Claimed usernames</h2>
        <p className="muted small">
          {claims.length} claimed · {claims.filter(c => c.redeemed_at).length} have since registered
        </p>
        {/* Not an <a href>. The route is owner-only behind a bearer token, and
            a navigation sends no headers — so the link answered 401 and the
            browser saved the refusal to disk under the name of the export. */}
        <button
          type="button"
          className="ghost small download"
          disabled={exporting}
          onClick={async () => {
            setExporting(true)
            try {
              save(await api.claimsCsv(), "devpipe-claims.csv")
            } catch (err: any) {
              onNote({ kind: "bad", text: String(err.message) })
            }
            setExporting(false)
          }}
        >
          <Download size={13} /> {exporting ? "Exporting…" : "Export CSV"}
        </button>
        <table>
          <tbody>
            {claims.slice(0, 40).map(c => (
              <tr key={c.id}>
                <td style={{ fontFamily: "var(--mono)" }}>@{c.username}</td>
                <td className="muted small">{c.email}</td>
                <td className="right muted small">
                  {c.redeemed_at ? <span className="pill ok">registered</span> : when(c.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {claims.length === 0 && <p className="muted small">Nobody has claimed a name yet.</p>}
      </section>

      <section className="card">
        <h2>Write to them</h2>
        <form onSubmit={compose}>
          <label className="field">
            <span>Audience</span>
            <select value={audience} onChange={e => setAudience(e.target.value)}>
              <option value="claims">Claimed usernames ({counts.claims ?? 0})</option>
              <option value="waitlist">Waitlist ({counts.waitlist ?? 0})</option>
              <option value="users">Registered users ({counts.users ?? 0})</option>
              <option value="all">Everyone ({counts.all ?? 0})</option>
            </select>
          </label>
          <label className="field">
            <span>Subject</span>
            <input value={subject} onChange={e => setSubject(e.target.value)} maxLength={160} />
          </label>
          <label className="field">
            <span>Message</span>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={8}
              placeholder="Plain text. A blank line starts a new paragraph."
            />
            <small className="muted">
              Plain text only — markup here would reach every inbox at once and there is no send to take back.
            </small>
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save draft"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Drafts and sent</h2>
        {!data && <Loader2 className="spin" size={14} />}
        <table>
          <tbody>
            {(data?.broadcasts ?? []).map(b => (
              <tr key={b.id}>
                <td>
                  <div>{b.subject}</div>
                  <div className="muted small">
                    {b.audience}
                    {b.sent_at
                      ? ` · sent ${when(b.sent_at)} · ${b.sent_count} delivered${
                          b.failed_count ? `, ${b.failed_count} failed` : ""
                        }`
                      : " · draft"}
                  </div>
                  {confirming === b.id && (
                    <div className="confirm">
                      <p className="note warn">
                        This reaches {counts[b.audience] ?? 0} addresses and cannot be undone. Type the subject to
                        confirm.
                      </p>
                      <div className="row-form">
                        <input
                          value={confirmText}
                          onChange={e => setConfirmText(e.target.value)}
                          placeholder={b.subject}
                        />
                        <button
                          type="button"
                          disabled={sending}
                          onClick={async () => {
                            setSending(true)
                            try {
                              const out = await api.adminSendBroadcast(b.id, confirmText)
                              const failed = out.failed ? `, ${out.failed} failed` : ""
                              onNote(
                                out.done
                                  ? { kind: "ok", text: `Sent to ${out.sent}${failed}.` }
                                  : {
                                      // Not an error. The send works to a time
                                      // budget rather than risking being cut
                                      // off, and the only thing to do about it
                                      // is press send again.
                                      kind: "ok",
                                      text: `Sent to ${out.sent}${failed}. ${out.remaining} left — press send again to carry on; nobody is mailed twice.`,
                                    },
                              )
                              if (out.done) {
                                setConfirming(null)
                                setConfirmText("")
                              }
                              refresh()
                            } catch (err: any) {
                              onNote({ kind: "bad", text: String(err.message) })
                            }
                            setSending(false)
                          }}
                        >
                          {sending ? "Sending…" : "Send now"}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            setConfirming(null)
                            setConfirmText("")
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </td>
                <td className="right">
                  {b.sent_at ? (
                    <span className="pill ok">
                      <Check size={11} /> sent
                    </span>
                  ) : (
                    <div className="actions">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={async () => {
                          try {
                            const out = await api.adminPreviewBroadcast(b.id)
                            onNote({ kind: "ok", text: `Preview sent to ${out.to}.` })
                          } catch (err: any) {
                            onNote({ kind: "bad", text: String(err.message) })
                          }
                        }}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => setConfirming(confirming === b.id ? null : b.id)}
                      >
                        <Send size={12} /> Send
                      </button>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={async () => {
                          await api.adminDeleteBroadcast(b.id).catch(() => {})
                          refresh()
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
