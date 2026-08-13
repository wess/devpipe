import { Loader2 } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"
import { when } from "../format.ts"
import { ADMIN_TABS, type AdminTab } from "../routes.ts"
import { Marketing } from "./Marketing.tsx"

/**
 * Everything only the instance owner sees.
 *
 * The tab lives in the URL rather than here. Eight screens behind one address
 * meant no way to link anyone to the one being talked about, and a reload in
 * the middle of configuring Stripe dropped you back on the overview.
 */
export const Admin: React.FC<{ tab: AdminTab; onTab: (tab: AdminTab) => void }> = ({ tab, onTab }) => {
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null)

  return (
    <div className="page">
      <h1>Admin</h1>
      <nav className="tabs">
        {ADMIN_TABS.map(t => (
          <button type="button" key={t} className={tab === t ? "on" : ""} onClick={() => onTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {note && <p className={`note ${note.kind === "bad" ? "bad" : "ok"}`}>{note.text}</p>}

      {tab === "overview" && <Overview />}
      {tab === "users" && <Users onNote={setNote} />}
      {tab === "boxes" && <Droplets />}
      {tab === "waitlist" && <Waitlist />}
      {tab === "marketing" && <Marketing onNote={setNote} />}
      {tab === "invites" && <Invites onNote={setNote} />}
      {tab === "settings" && <InstanceSettings onNote={setNote} />}
      {tab === "billing" && <Billing onNote={setNote} />}
      {tab === "audit" && <Audit />}
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
  useEffect(() => {
    api
      .adminOverview()
      .then(setData)
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
      {!data.provider_configured && (
        <p className="note warn">
          No provider is connected, so nobody can create a box. Add a DigitalOcean token under Settings.
        </p>
      )}
      {data.provider_error && <p className="note bad">{data.provider_error}</p>}
    </>
  )
}

const Users: React.FC<{ onNote: (n: { kind: "ok" | "bad"; text: string }) => void }> = ({ onNote }) => {
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
        <p className="note warn">
          This token can create and destroy every box on the account. It is stored server-side and never sent back to a
          browser. If this machine is compromised, revoke it in the DigitalOcean console rather than only deleting it
          here.
        </p>
        <form
          onSubmit={async e => {
            e.preventDefault()
            try {
              const out = await api.adminSaveProvider(token)
              setToken("")
              onNote({ kind: "ok", text: `Connected as ${out.account.email}.` })
              void refresh()
            } catch (err: any) {
              onNote({ kind: "bad", text: String(err.message) })
            }
          }}
        >
          <label className="field">
            <span>
              DigitalOcean API token
              {data.provider.digitalocean && ` — currently ${data.provider.digitalocean}`}
            </span>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="dop_v1_…"
              required
            />
          </label>
          <button type="submit">{data.provider.digitalocean ? "Replace" : "Connect"}</button>
        </form>
        {data.provider.digitalocean && (
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
    </>
  )
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

const Billing: React.FC<{ onNote: (n: { kind: "ok" | "bad"; text: string }) => void }> = ({ onNote }) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminBilling>> | null>(null)
  const [margin, setMargin] = useState("")
  const [secret, setSecret] = useState("")
  const [hook, setHook] = useState("")

  const refresh = useCallback(
    () =>
      api
        .adminBilling()
        .then(d => {
          setData(d)
          setMargin(String(d.margin_pct))
        })
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  if (!data) return <Loader2 className="spin" size={16} />

  const save = async (values: Parameters<typeof api.adminSaveBilling>[0]) => {
    try {
      const out = await api.adminSaveBilling(values)
      setSecret("")
      setHook("")
      onNote({ kind: "ok", text: out.changed.length ? `Saved: ${out.changed.join(", ")}.` : "Nothing changed." })
      void refresh()
    } catch (err: any) {
      onNote({ kind: "bad", text: String(err.message) })
    }
  }

  // Previewed from the number in the box rather than from the saved one, so
  // the effect of a margin is visible before it is charged to anybody.
  const preview = Number(margin)
  const multiplier = Number.isFinite(preview) && preview >= 0 ? 1 + preview / 100 : 1

  return (
    <>
      <section className="card">
        <h2>Stripe</h2>
        {!data.configured && (
          <p className="note warn">
            Until both keys are here, nobody can subscribe and nothing gates a box. The instance sells nothing and
            creating a box is free.
          </p>
        )}
        {data.livemode !== null && (
          <p className={`note ${data.livemode ? "warn" : ""}`}>
            {data.livemode ? "Live keys — these charge real cards." : "Test keys — nothing here moves money."}
          </p>
        )}
        <p className="note">
          The webhook endpoint is <code>/api/billing/webhook</code>. Subscribe it to checkout.session.completed and the
          three customer.subscription events; a subscription only exists once one of those arrives.
        </p>
        <form
          onSubmit={e => {
            e.preventDefault()
            void save({
              // An empty field means leave it alone, so a key already stored
              // does not have to be pasted again to change the other one.
              ...(secret.trim() ? { secret_key: secret.trim() } : {}),
              ...(hook.trim() ? { webhook_secret: hook.trim() } : {}),
            })
          }}
        >
          <label className="field">
            <span>Secret key{data.secret_key && ` — currently ${data.secret_key}`}</span>
            <input
              type="password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              placeholder={data.secret_key ?? "sk_live_…"}
              autoComplete="off"
            />
            <small className="muted">Checked against Stripe before it is stored.</small>
          </label>
          <label className="field">
            <span>Webhook signing secret{data.webhook_secret && ` — currently ${data.webhook_secret}`}</span>
            <input
              type="password"
              value={hook}
              onChange={e => setHook(e.target.value)}
              placeholder={data.webhook_secret ?? "whsec_…"}
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={!secret.trim() && !hook.trim()}>
            Save keys
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Margin</h2>
        <form
          onSubmit={e => {
            e.preventDefault()
            void save({ margin_pct: Number(margin) })
          }}
        >
          <label className="field">
            <span>Percent on top of provider cost</span>
            <input value={margin} onChange={e => setMargin(e.target.value)} inputMode="decimal" />
            <small className="muted">100 means the customer pays double what the droplet costs.</small>
          </label>
          <table>
            <thead>
              <tr>
                <th>Size</th>
                <th className="right">Cost</th>
                <th className="right">Price</th>
              </tr>
            </thead>
            <tbody>
              {data.plans.map(p => (
                <tr key={p.size}>
                  <td>{p.label}</td>
                  <td className="right muted">{money(p.cost_cents)}</td>
                  <td className="right">{money(Math.round(p.cost_cents * multiplier))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="submit">Save margin</button>
        </form>
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
