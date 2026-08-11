import { Loader2, Monitor } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"
import { when } from "../format.ts"

/** The signed-in user's own account: profile, password, and signed-in devices. */
export const Settings: React.FC<{ onSaved?: (user: api.User) => void }> = ({ onSaved }) => {
  const user = api.currentUser()
  const [name, setName] = useState(user?.name ?? "")
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.listSessions>>>([])
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(
    () =>
      api
        .listSessions()
        .then(setSessions)
        .catch(() => {})
        .finally(() => setLoading(false)),
    [],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      // Handed back up so the shell re-renders from the saved user rather than
      // from the copy it read when it mounted.
      onSaved?.(await api.updateProfile(name))
      setNote({ kind: "ok", text: "Saved." })
    } catch (err: any) {
      setNote({ kind: "bad", text: String(err.message) })
    }
  }

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.changePassword(current, next)
      setCurrent("")
      setNext("")
      setNote({ kind: "ok", text: "Password changed. Other devices were signed out." })
      void refresh()
    } catch (err: any) {
      setNote({ kind: "bad", text: String(err.message) })
    }
  }

  return (
    <div className="page">
      <h1>Settings</h1>
      {note && <p className={`note ${note.kind === "bad" ? "bad" : "ok"}`}>{note.text}</p>}

      <section className="card">
        <h2>Profile</h2>
        <form onSubmit={saveProfile}>
          <label className="field">
            <span>Email</span>
            <input value={user?.email ?? ""} disabled />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={user?.username ?? ""} disabled />
            <small className="muted">Boxes are named from this, so it does not change.</small>
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} />
          </label>
          <button type="submit">Save</button>
        </form>
      </section>

      <section className="card">
        <h2>Password</h2>
        <form onSubmit={savePassword}>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={next}
              onChange={e => setNext(e.target.value)}
              autoComplete="new-password"
              required
            />
            <small className="muted">At least 12 characters. Changing it signs out every other device.</small>
          </label>
          <button type="submit">Change password</button>
        </form>
      </section>

      <section className="card">
        <h2>Signed in devices</h2>
        {loading && <Loader2 className="spin" size={14} />}
        <table>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id}>
                <td>
                  <Monitor size={13} />
                </td>
                <td>
                  <div>{s.user_agent?.slice(0, 60) || "Unknown device"}</div>
                  <div className="muted small">
                    {s.ip || "no address"} · last seen {when(s.last_seen_at)}
                  </div>
                </td>
                <td className="right">
                  {s.current ? (
                    <span className="muted small">This device</span>
                  ) : (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={async () => {
                        await api.revokeSession(s.id)
                        void refresh()
                      }}
                    >
                      Sign out
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length > 1 && (
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              await api.revokeOtherSessions()
              void refresh()
            }}
          >
            Sign out everywhere else
          </button>
        )}
      </section>
    </div>
  )
}
