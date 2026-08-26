import { AlertTriangle, Check, Loader2, ShieldCheck } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import * as api from "../api.ts"

/**
 * First launch.
 *
 * Not a form. Every step here is a question whose wrong answer surfaces hours
 * later as something that looks unrelated — a certificate that never arrives, a
 * box that cannot be reached, a token sitting in the database as text — so each
 * one is checked against the provider before it is accepted, and each says what
 * goes wrong without it rather than what it is called.
 *
 * The two optional steps are genuinely optional and look it. An instance that
 * declines a spend cap should be told once what that means and then left alone;
 * one that cannot proceed without a domain should not be able to press Finish.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export const Setup: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [state, setState] = useState<api.SetupState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [token, setToken] = useState("")
  const [domains, setDomains] = useState<string[]>([])
  const [domain, setDomain] = useState("")
  const [keys, setKeys] = useState<{ id: number; name: string }[]>([])
  const [chosenKeys, setChosenKeys] = useState<Set<number>>(new Set())
  const [cap, setCap] = useState(5000)
  const [secret, setSecret] = useState<{ key: string; path: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await api.setupState()
      setState(s)
      if (s.domain) setDomain(s.domain)
      if (s.spend_cap_cents > 0) setCap(s.spend_cap_cents)
    } catch (e: any) {
      setError(String(e.message))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Only DigitalOcean has account SSH keys to choose here.
  const providerDone = state?.steps.find(s => s.id === "provider")?.done ?? false
  useEffect(() => {
    if (!providerDone || state?.provider !== "digitalocean") return
    void api
      .setupSshKeys()
      .then(out => {
        setKeys(out.keys)
        setChosenKeys(new Set(out.chosen.map(Number)))
      })
      .catch(() => {})
  }, [providerDone, state?.provider])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e: any) {
      setError(String(e.message))
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <div className="page">{error ? <p className="note bad">{error}</p> : <Loader2 className="spin" size={16} />}</div>
    )
  }

  const step = (id: api.SetupStep["id"]) => state.steps.find(s => s.id === id)
  const done = (id: api.SetupStep["id"]) => step(id)?.done ?? false

  const Head: React.FC<{ id: api.SetupStep["id"] }> = ({ id }) => {
    const s = step(id)
    if (!s) return null
    return (
      <>
        <h2>
          {s.done ? <Check size={15} className="ok" /> : s.required ? null : <span className="pill">optional</span>}{" "}
          {s.title}
        </h2>
        <p className="muted small">{s.detail}</p>
      </>
    )
  }

  return (
    <div className="page">
      <h1>Set this instance up</h1>
      <p className="muted">
        Four things it needs and two it is better with. Everything here is stored on this machine and nothing is sent
        anywhere else.
      </p>
      {error && <p className="note bad">{error}</p>}

      <section className="card">
        <Head id="secret" />
        {state.sealed ? (
          <p className="note ok">
            <ShieldCheck size={14} /> Credentials on this instance are encrypted at rest.
          </p>
        ) : (
          <>
            <p className="note warn">
              <AlertTriangle size={14} /> Right now the provider credential below will be stored as readable text. A
              copy of the database — a backup, a dump, a snapshot — is a copy of a credential that can create and
              destroy machines on the account.
            </p>
            {secret ? (
              <>
                <p className="muted small">
                  Put this in <code>{secret.path}</code> and restart the service. It is shown once and is not kept here:
                  it is what encrypts the credentials, so an instance holding a copy would be a lock with the key left
                  inside it.
                </p>
                <pre className="secret">DEVPIPE_SECRET_KEY={secret.key}</pre>
                <button type="button" className="ghost" onClick={() => void refresh()}>
                  I have restarted it
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void run(async () => setSecret(await api.setupSecret()))}>
                Generate a key
              </button>
            )}
          </>
        )}
      </section>

      <section className="card">
        <Head id="provider" />
        {state.account ? (
          <p className="note ok">
            Connected to {state.account.email}
            {state.provider === "digitalocean"
              ? ` — ${state.account.dropletLimit} droplets allowed on this account.`
              : "."}
          </p>
        ) : null}
        {state.provider_error && <p className="note bad">{state.provider_error}</p>}
        {state.provider === "docker" ? (
          <p className="muted small">
            Build <code>devpipe-box:local</code> and keep Docker running on this host. No provider credential is stored.
          </p>
        ) : (
          <>
            <div className="wizard-inline">
              <label className="field">
                <span>{state.account ? "Replace the credential" : "API credential"}</span>
                <input
                  type="password"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder={state.provider === "runpod" ? "Runpod API key" : "dop_v1_…"}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                disabled={busy || !token.trim()}
                onClick={() =>
                  void run(async () => {
                    const out = await api.setupProvider(token.trim())
                    setToken("")
                    setDomains(out.domains)
                    if (!domain && out.domains.length === 1) setDomain(out.domains[0] as string)
                  })
                }
              >
                {busy ? "Checking…" : "Connect"}
              </button>
            </div>
            <p className="muted small">
              {state.provider === "runpod"
                ? "Create the key in Runpod Settings. The adapter also requires DEVPIPE_RUNPOD_IMAGE on the server."
                : "Made under API → Tokens in the DigitalOcean console, with read and write access."}{" "}
              It is checked before it is stored, so a credential that does not work is refused now rather than at the
              first box.
            </p>
          </>
        )}
      </section>

      {state.provider === "digitalocean" && (
        <section className="card">
          <Head id="domain" />
          {domains.length > 0 && !done("domain") && (
            <div className="choice-grid">
              {domains.map(d => (
                <button
                  type="button"
                  key={d}
                  className={`choice ${domain === d ? "on" : ""}`}
                  onClick={() => setDomain(d)}
                >
                  <strong>{d}</strong>
                  <span className="muted small">On this account</span>
                </button>
              ))}
            </div>
          )}
          <div className="wizard-inline">
            <label className="field">
              <span>Domain</span>
              <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="devpipe.example" />
            </label>
            <button
              type="button"
              disabled={busy || !domain.trim() || !providerDone}
              onClick={() => void run(() => api.setupDomain(domain.trim()))}
            >
              {busy ? "Checking…" : "Use this domain"}
            </button>
          </div>
          <p className="muted small">
            Its DNS has to be on the same DigitalOcean account, because that is where each box's record is written. A
            domain pointed anywhere else builds boxes that come up perfectly, never resolve and never get a certificate
            — so this is checked against the provider rather than taken on trust.
          </p>
        </section>
      )}

      {state.provider === "digitalocean" && (
        <section className="card">
          <Head id="keys" />
          {keys.length === 0 ? (
            <p className="muted small">
              {providerDone
                ? "This account has no SSH keys. Add one in the DigitalOcean console and reload."
                : "Connect a provider first."}
            </p>
          ) : (
            <>
              <div className="choice-grid">
                {keys.map(k => (
                  <button
                    type="button"
                    key={k.id}
                    className={`choice ${chosenKeys.has(k.id) ? "on" : ""}`}
                    onClick={() => {
                      const next = new Set(chosenKeys)
                      if (next.has(k.id)) next.delete(k.id)
                      else next.add(k.id)
                      setChosenKeys(next)
                    }}
                  >
                    <strong>{k.name}</strong>
                    {chosenKeys.has(k.id) && <span className="muted small">On every new box</span>}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => api.saveSetupSshKeys([...chosenKeys]))}
              >
                Save keys
              </button>
            </>
          )}
        </section>
      )}

      <section className="card">
        <Head id="cap" />
        <div className="wizard-inline">
          <label className="field">
            <span>Most this instance may spend in a month</span>
            <select value={cap} onChange={e => setCap(Number(e.target.value))}>
              {[0, 2500, 5000, 10_000, 25_000, 50_000, 100_000].map(cents => (
                <option key={cents} value={cents}>
                  {cents === 0 ? "No cap" : money(cents)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void run(() => api.setupCap(cap))}>
            Save cap
          </button>
        </div>
        <p className="muted small">
          Counted against DigitalOcean's own prices — droplets and volumes both — and accumulated over the calendar
          month, so destroying a box does not undo what it already cost. Past the cap nothing new starts and what is
          running is put to sleep onto its workspace. With no cap, the thing that actually happens is a box left running
          over a holiday and found on an invoice.
        </p>
      </section>

      <section className="card">
        <h2>Finish</h2>
        {state.usable ? (
          <p className="muted small">Everything it needs is in place. The optional steps can be done later in Admin.</p>
        ) : (
          <p className="note warn">
            Still to do:{" "}
            {state.steps
              .filter(s => s.required && !s.done)
              .map(s => s.title)
              .join(", ")}
            .
          </p>
        )}
        <button
          type="button"
          disabled={busy || !state.usable}
          onClick={() =>
            void run(async () => {
              await api.setupFinish()
              onDone()
            })
          }
        >
          Done — take me in
        </button>
      </section>
    </div>
  )
}
