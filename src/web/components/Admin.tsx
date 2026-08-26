import { Loader2 } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"
import { when } from "../format.ts"
import { ADMIN_TABS, type AdminTab } from "../routes.ts"
import { Marketing } from "./Marketing.tsx"

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * Running the instance.
 *
 * An admin sees the people, the boxes and the audit log; an owner sees those
 * and everything that spends money — the credentials, the prices, the spending
 * cap. The tabs that are entirely owner-only are not rendered at all rather
 * than rendered and refused, because a screen you can open and cannot use is a
 * worse answer than one that is not offered.
 *
 * The tab lives in the URL rather than here. Eight screens behind one address
 * meant no way to link anyone to the one being talked about, and a reload in
 * the middle of configuring the instance dropped you back on the overview.
 */
const OWNER_ONLY: AdminTab[] = ["settings", "marketing"]

export const Admin: React.FC<{ tab: AdminTab; onTab: (tab: AdminTab) => void }> = ({ tab, onTab }) => {
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null)
  const isOwner = api.currentUser()?.role === "owner"
  const tabs = ADMIN_TABS.filter(t => isOwner || !OWNER_ONLY.includes(t))
  // A link to an owner-only tab, followed by somebody who is not one.
  const showing = tabs.includes(tab) ? tab : "overview"

  return (
    <div className="page">
      <h1>Admin</h1>
      <nav className="tabs">
        {tabs.map(t => (
          <button type="button" key={t} className={showing === t ? "on" : ""} onClick={() => onTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {note && <p className={`note ${note.kind === "bad" ? "bad" : "ok"}`}>{note.text}</p>}

      {showing === "overview" && <Overview />}
      {showing === "users" && <Users onNote={setNote} canManage={isOwner} />}
      {showing === "boxes" && <Droplets />}
      {showing === "waitlist" && <Waitlist />}
      {showing === "marketing" && <Marketing onNote={setNote} />}
      {showing === "invites" && <Invites onNote={setNote} />}
      {showing === "settings" && <InstanceSettings onNote={setNote} />}
      {showing === "audit" && <Audit />}
    </div>
  )
}

/**
 * Who is waiting for an account.
 *
 * The overview has counted these since the beginning and there was no screen
 * that showed them, which made the number the one statistic on that page you
 * could not act on. Addresses here are the audience a broadcast goes to, so
 * seeing the list is what makes choosing that audience an informed decision.
 */
const Waitlist: React.FC = () => {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.adminWaitlist>>>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .adminWaitlist()
      .then(setRows)
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Loader2 className="spin" size={16} />
  if (error) return <p className="note bad">{error}</p>

  return (
    <section className="card">
      <p className="muted small">{rows.length} waiting</p>
      {rows.length === 0 ? (
        <p className="muted small">Nobody has joined the waitlist yet.</p>
      ) : (
        <table>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.email}</td>
                <td className="right muted small">{when(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

const Overview: React.FC = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminOverview>> | null>(null)
  const [cap, setCap] = useState<api.Cap | null>(null)
  useEffect(() => {
    api
      .adminOverview()
      .then(setData)
      .catch(() => {})
    api
      .spendCap()
      .then(setCap)
      .catch(() => {})
  }, [])
  if (!data) return <Loader2 className="spin" size={16} />

  return (
    <>
      <div className="stat-grid">
        {[
          [data.users, "users"],
          [data.boxes, "boxes"],
          [data.waitlist, "waitlist"],
          [data.suspended, "suspended"],
          [`$${data.monthly_spend.toFixed(0)}`, "per month"],
        ].map(([n, k]) => (
          <div key={String(k)} className="card stat">
            <div className="n">{n}</div>
            <div className="k">{k}</div>
          </div>
        ))}
      </div>

      {/* What the provider will actually charge, accumulated over its own
          billing month. Counted from droplets and volumes both — a figure that
          left volumes out would read low and be trusted anyway. */}
      {cap && (
        <div className="card">
          <h2>Spending this month</h2>
          <div className="price">
            {money(cap.spent_cents)}
            <span>{cap.cap_cents > 0 ? ` of ${money(cap.cap_cents)}` : " — no cap set"}</span>
          </div>
          <p className="muted small">
            Running at {money(Math.round(cap.run_rate_cents_per_hour))} an hour
            {cap.reached_at ? `, which reaches the cap ${when(cap.reached_at)}` : ""}. Since {when(cap.period_start)}.
          </p>
          {cap.over && (
            <p className="note bad">
              The cap has been reached. Nothing new will start, and running boxes are being put to sleep onto their
              workspaces.
            </p>
          )}
          {!cap.over && cap.warning && (
            <p className="note warn">
              Past {cap.warn_at_pct}% of the cap. At the current rate the instance stops starting machines
              {cap.reached_at ? ` ${when(cap.reached_at)}` : " shortly"}.
            </p>
          )}
        </div>
      )}
      {!data.provider_configured && (
        <p className="note warn">
          {data.provider} is not configured, so nobody can create a box. Finish its setup under Settings.
        </p>
      )}
      {data.provider_error && <p className="note bad">{data.provider_error}</p>}
    </>
  )
}

const ROLE_LABEL: Record<api.Role, string> = { owner: "Owner", admin: "Admin", user: "Member" }

/**
 * The team.
 *
 * Roles are only offered to the owner, because only the owner may set them.
 * The owner row has no controls at all: there is exactly one, and moving it is
 * a transfer rather than an edit — which is what the confirmation says, since
 * the person doing it stops being able to undo it the moment it lands.
 */
const Users: React.FC<{ onNote: (n: { kind: "ok" | "bad"; text: string }) => void; canManage: boolean }> = ({
  onNote,
  canManage,
}) => {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.adminUsers>>>([])
  const refresh = useCallback(
    () =>
      api
        .adminUsers()
        .then(setRows)
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section className="card">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Boxes</th>
            <th>Joined</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(u => (
            <tr key={u.id}>
              <td>
                <div>
                  {u.name || u.username} {u.is_owner && <span className="pill">owner</span>}
                  {u.suspended_at && <span className="pill bad">suspended</span>}
                </div>
                <div className="muted small">
                  {u.email} · @{u.username}
                </div>
              </td>
              <td>
                {u.is_owner || !canManage ? (
                  <span className="muted small">{ROLE_LABEL[u.role]}</span>
                ) : (
                  <select
                    value={u.role}
                    disabled={Boolean(u.suspended_at)}
                    onChange={async e => {
                      const role = e.target.value as api.Role
                      if (
                        role === "owner" &&
                        !confirm(
                          `Hand this instance to ${u.email}?\n\nThere is only one owner. You become an admin, and everything owner-only — the provider token, the payment keys, the spending cap — stops being yours to change.`,
                        )
                      ) {
                        return
                      }
                      try {
                        const out = await api.adminSetRole(u.id, role)
                        onNote(
                          out.transferred
                            ? { kind: "ok", text: `${u.email} owns this instance now. You are an admin.` }
                            : { kind: "ok", text: `${u.email} is now ${ROLE_LABEL[role].toLowerCase()}.` },
                        )
                        void refresh()
                      } catch (err: any) {
                        onNote({ kind: "bad", text: String(err.message) })
                      }
                    }}
                  >
                    <option value="user">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner — hand over</option>
                  </select>
                )}
              </td>
              <td>{u.boxes}</td>
              <td className="muted small">{when(u.created_at)}</td>
              <td className="right">
                {!u.is_owner && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={async () => {
                      try {
                        const out = await api.adminSuspend(u.id, !u.suspended_at)
                        // Suspending condemns boxes as well as ending
                        // sessions, and the count is the answer to the
                        // question the owner actually has.
                        if (out.boxes !== undefined) {
                          onNote({
                            kind: "ok",
                            text: `Ended ${out.sessions} sessions, marked ${out.boxes} boxes for destruction.`,
                          })
                        }
                        void refresh()
                      } catch (e: any) {
                        onNote({ kind: "bad", text: String(e.message) })
                      }
                    }}
                  >
                    {u.suspended_at ? "Restore" : "Suspend"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const Droplets: React.FC = () => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminDroplets>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .adminDroplets()
      .then(setData)
      .catch(e => setError(String(e.message)))
  }, [])

  if (error) return <p className="note bad">{error}</p>
  if (!data) return <Loader2 className="spin" size={16} />
  if (!data.configured) return <p className="muted">Connect a provider first.</p>

  return (
    <section className="card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Address</th>
            <th>Size</th>
            <th className="right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.droplets.map(d => (
            <tr key={d.id}>
              <td>
                {d.name}{" "}
                {/* A droplet Devpipe did not create is still on the bill, so it
                    is listed rather than filtered out. */}
                {!d.managed && <span className="pill">unmanaged</span>}
              </td>
              <td>
                <span className={`pill ${d.status === "active" ? "ok" : ""}`}>{d.status}</span>
              </td>
              <td className="muted small">{d.ip}</td>
              <td className="muted small">
                {d.memoryMb} MB · {d.vcpus} vcpu
              </td>
              <td className="right">${d.monthly}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const InstanceSettings: React.FC<{
  onNote: (n: { kind: "ok" | "bad"; text: string }) => void
}> = ({ onNote }) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminSettings>> | null>(null)
  const [token, setToken] = useState("")
  const refresh = useCallback(
    () =>
      api
        .adminSettings()
        .then(setData)
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  if (!data) return <Loader2 className="spin" size={16} />

  const field = (key: string, label: string, hint?: string) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <input
        defaultValue={data.settings[key] ?? ""}
        onBlur={async e => {
          try {
            await api.adminSaveSettings({ [key]: e.target.value })
            onNote({ kind: "ok", text: "Saved." })
          } catch (err: any) {
            onNote({ kind: "bad", text: String(err.message) })
          }
        }}
      />
      {hint && <small className="muted">{hint}</small>}
    </label>
  )

  return (
    <>
      <section className="card">
        <h2>Provider</h2>
        {data.provider.kind === "docker" ? (
          <p className={data.provider.configured ? "note ok" : "note warn"}>
            Local Docker is configured on the host. Build the Devpipe box image and keep the Docker daemon available to
            this service.
          </p>
        ) : (
          <>
            <p className="note warn">
              This credential can create and destroy every box on the account. It is stored server-side and never sent
              back to a browser. If this machine is compromised, revoke it in the {data.provider.label} console rather
              than only deleting it here.
            </p>
            <form
              onSubmit={async e => {
                e.preventDefault()
                try {
                  const out = await api.adminSaveProvider(token)
                  setToken("")
                  onNote({ kind: "ok", text: `Connected ${out.account.label}.` })
                  void refresh()
                } catch (err: any) {
                  onNote({ kind: "bad", text: String(err.message) })
                }
              }}
            >
              <label className="field">
                <span>
                  {data.provider.label} API credential
                  {data.provider.credential && ` — currently ${data.provider.credential}`}
                </span>
                <input
                  type="password"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder={data.provider.kind === "runpod" ? "rpa_…" : "dop_v1_…"}
                  required
                />
              </label>
              <button type="submit">{data.provider.credential ? "Replace" : "Connect"}</button>
            </form>
          </>
        )}
        {/* Said rather than left to be assumed. This token creates and destroys
            every droplet on the account and spends money with no ceiling, and
            backups of the table it lives in leave the database host. Whether it
            is readable in one is not a detail to keep to ourselves. */}
        {data.secrets_sealed === false && (
          <p className="note warn">
            The provider token is stored <strong>unencrypted</strong>, because
            <code> DEVPIPE_SECRET_KEY</code> is not set on this instance. Generate one with
            <code> openssl rand -base64 32</code>, add it to <code>/etc/devpipe.env</code>, and restart — existing
            values are encrypted the next time they are read.
          </p>
        )}
        {data.provider.credential && (
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              await api.adminClearProvider()
              void refresh()
            }}
          >
            Disconnect
          </button>
        )}
      </section>

      <section className="card">
        <h2>Instance</h2>
        {field("signups_open", "Signups open", "1 to allow new accounts, 0 to close them.")}
        {field("boxes_domain", "Box domain", "Boxes get a subdomain of this.")}
        {field("boxes_limit_per_user", "Boxes per user")}
        {field("boxes_default_region", "Default region")}
        {field("boxes_default_size", "Default size")}
        {field("daemon_url", "Daemon download URL", "Where a new box fetches devpiped.")}
        {field(
          "boxes_ssh_key_ids",
          "SSH key ids for new boxes",
          "Comma separated, from DigitalOcean. Without one, a box that wedges during setup cannot be inspected.",
        )}
        {field(
          "boxes_ssh_sources",
          "Extra addresses allowed to SSH a box",
          "Comma separated CIDR. This host is always allowed; add a home or office address to reach a wedged box without hopping through it first. Empty is normal.",
        )}
        {field(
          "boxes_egress_limit_gb",
          "Egress worth a look, per hour",
          "Gigabytes out in an hour. Catches a burst — a seedbox, a mirror. 0 turns the check off.",
        )}
        {field(
          "boxes_egress_daily_gb",
          "Egress worth a look, per day",
          "Gigabytes out in a day. Catches the patient version the hourly figure is blind to. 0 turns the check off.",
        )}
      </section>

      <section className="card">
        <h2>Spending</h2>
        <p className="muted small">
          The provider's own prices, droplets and volumes both, accumulated over the calendar month. Past the cap
          nothing new starts and what is running is put to sleep onto its workspace — which is safe precisely because a
          box without a workspace is never touched.
        </p>
        {field(
          "billing_spend_cap_cents",
          "Monthly cap, in cents",
          "0 is no cap. 5000 is fifty dollars. Counted against what DigitalOcean charges, not what customers are charged.",
        )}
        {field("billing_spend_warn_pct", "Start warning at", "A percentage of the cap. 80 is four fifths of it.")}
      </section>

      <section className="card">
        <h2>GPU boxes</h2>
        <p className="muted small">
          Hourly machines, from $0.76 to $4.41 an hour at DigitalOcean's own prices. Off until this says otherwise, and
          even then only an admin can start one — the bill lands on this instance's provider account.
        </p>
        {field("boxes_gpu_enabled", "Offer GPU boxes", "1 to show them in the wizard, 0 to hide them.")}
        {field(
          "boxes_gpu_idle_hours",
          "Sleep a GPU box after",
          "Hours idle. Unlike the other idle settings this cannot be turned off — below 1 is read as 1.",
        )}
      </section>
    </>
  )
}

const Invites: React.FC<{ onNote: (n: { kind: "ok" | "bad"; text: string }) => void }> = ({ onNote }) => {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.adminInvites>>>([])
  const [note, setNote] = useState("")
  const refresh = useCallback(
    () =>
      api
        .adminInvites()
        .then(setRows)
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section className="card">
      <p className="note warn">
        While signups are closed, an invite is the only way in — and registering leads straight to creating a box, which
        costs you money. Hand these out deliberately.
      </p>
      <form
        onSubmit={async e => {
          e.preventDefault()
          try {
            const made = await api.adminCreateInvite(note)
            setNote("")
            onNote({ kind: "ok", text: `Created ${made.code}` })
            void refresh()
          } catch (err: any) {
            onNote({ kind: "bad", text: String(err.message) })
          }
        }}
      >
        <div className="row-form">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Who is this for?" />
          <button type="submit">New invite</button>
        </div>
      </form>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>For</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(i => (
            <tr key={i.id}>
              <td style={{ fontFamily: "var(--mono)" }}>{i.code}</td>
              <td className="muted small">{i.note}</td>
              <td>
                {i.used_at ? (
                  <span className="pill">used {when(i.used_at)}</span>
                ) : (
                  <span className="pill ok">unused</span>
                )}
              </td>
              <td className="right">
                {!i.used_at && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={async () => {
                      await api.adminRevokeInvite(i.id)
                      void refresh()
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const Audit: React.FC = () => {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.adminAudit>>>([])
  useEffect(() => {
    api
      .adminAudit()
      .then(setRows)
      .catch(() => {})
  }, [])
  return (
    <section className="card">
      <table>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="muted small">{when(r.created_at)}</td>
              <td>{r.action}</td>
              <td className="muted small">{r.detail}</td>
              <td className="muted small right">{r.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
