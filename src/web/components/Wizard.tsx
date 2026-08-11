import { Check, Loader2, X } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { SHELLS, type ShellName } from "../../util/shell.ts"
import type { Catalog, Tool } from "../api.ts"
import * as api from "../api.ts"

/**
 * Setting up a box.
 *
 * Three steps rather than one long form, because the choices depend on each
 * other: what you install decides how much memory you need, which decides
 * which sizes are honest options. Showing all of it at once invites picking a
 * $4 box and a database and finding out later.
 *
 * The selection is stored with the box, so it can be rebuilt identically. That
 * is the real point — it makes destroying a box a reversible act.
 */

const GROUPS: { key: Tool["group"]; title: string; blurb: string }[] = [
  // Shells are chosen with the Shell control, not ticked here — picking one
  // there adds its package, and ticking it here would install a shell the box
  // never switches to.
  { key: "agent", title: "Agents", blurb: "The CLI you will actually work in." },
  { key: "runtime", title: "Runtimes", blurb: "Languages your projects need." },
  { key: "tooling", title: "Tools", blurb: "The small things you would miss." },
  { key: "service", title: "Services", blurb: "Run alongside your work. These are hungry." },
]

const OS_OVERHEAD_MB = 140

export const Wizard: React.FC<{ onClose: () => void; onCreated: (id: number) => void }> = ({ onClose, onCreated }) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [billing, setBilling] = useState<api.BillingStatus | null>(null)
  const [step, setStep] = useState(0)
  // Empty rather than "My box". A prefilled name is a name nobody changes, and
  // the server falls back to "box" if this is left alone anyway.
  const [name, setName] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [shell, setShell] = useState<ShellName>("bash")
  const [synapse, setSynapse] = useState(false)
  const [region, setRegion] = useState("nyc3")
  const [size, setSize] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshBilling = useCallback(() => api.billingStatus().then(setBilling), [])

  useEffect(() => {
    api
      .catalog()
      .then(c => {
        setCatalog(c)
        setPicked(new Set(c.defaults))
        setRegion(c.regions[0]?.slug ?? "nyc3")
      })
      .catch(e => setError(String(e.message)))
    // An instance that sells nothing answers `configured: false`, and every
    // size stays available — so a failure here must not block the wizard.
    void refreshBilling().catch(() => {})
  }, [refreshBilling])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  /** Whether a subscription already covers a box of this size. */
  const covered = (slug: string) => !billing?.configured || billing.can_create.includes(slug)

  // Dependencies are resolved here as well as on the server so the memory
  // figure the user is shown matches what will actually be installed.
  const resolved = useMemo(() => {
    if (!catalog) return []
    const wanted = new Set<string>()
    const add = (id: string) => {
      const tool = catalog.tools.find(t => t.id === id)
      if (!tool || wanted.has(id)) return
      for (const dep of tool.requires ?? []) add(dep)
      wanted.add(id)
    }
    for (const id of picked) add(id)
    return catalog.tools.filter(t => wanted.has(t.id))
  }, [catalog, picked])

  const needed = resolved.reduce((sum, t) => sum + t.memoryMb, 0) + OS_OVERHEAD_MB

  const sizes = catalog?.sizes ?? []
  const smallestThatFits = sizes.find(s => s.memoryMb >= needed)

  useEffect(() => {
    // Follow the selection rather than stranding the user on a size that no
    // longer fits what they picked.
    if (smallestThatFits && !sizes.find(s => s.slug === size && s.memoryMb >= needed)) {
      setSize(smallestThatFits.slug)
    }
  }, [smallestThatFits, needed, size, sizes])

  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const box = await api.createBox({ name, region, size, shell, synapse, tools: [...picked] })
      onCreated(box.id)
    } catch (e: any) {
      // 402 means the subscription this size needs is missing or was taken by
      // another box between the check and the create. The message already says
      // what to do; re-reading billing is what turns the footer into a
      // checkout button.
      setError(String(e.message))
      if (e.status === 402) await refreshBilling().catch(() => {})
      setBusy(false)
    }
  }

  const subscribe = async () => {
    setBusy(true)
    try {
      location.href = (await api.billingCheckout(size)).url
    } catch (e: any) {
      setError(String(e.message))
      setBusy(false)
    }
  }

  const autoDeps = resolved.filter(t => !picked.has(t.id))

  return (
    <div className="modal-backdrop">
      {/* The scrim is a real button rather than a div with a click handler, so
          dismissing by clicking outside is reachable from the keyboard too. */}
      <button type="button" className="modal-scrim" aria-label="Close" onClick={onClose} />
      <dialog className="modal wizard" open aria-label="New box">
        <header>
          <div>
            <h2>New box</h2>
            <p className="muted">{["What goes on it", "How big and where", "Check it over"][step]}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        {error && <p className="note bad">{error}</p>}
        {!catalog && !error && (
          <p className="muted">
            <Loader2 className="spin" size={14} /> Loading…
          </p>
        )}

        {catalog && step === 0 && (
          <div className="wizard-body">
            {/* Sat above the tool grid unlabelled, prefilled "My box", and
                read as a heading rather than a decision — so every box got
                called "My box". */}
            <label className="field">
              <span>Name this box</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={40}
                placeholder="What you will call it in the sidebar"
              />
              <small className="muted">
                Yours to read, not the network's. The address is built from your username — this never becomes a
                hostname, a DNS record or part of a certificate.
              </small>
            </label>

            {GROUPS.map(group => (
              <section key={group.key} className="tool-group">
                <h3>{group.title}</h3>
                <p className="muted small">{group.blurb}</p>
                <div className="tool-grid">
                  {catalog.tools
                    .filter(t => t.group === group.key)
                    .map(tool => {
                      const on = picked.has(tool.id)
                      const auto = !on && resolved.some(r => r.id === tool.id)
                      return (
                        <button
                          type="button"
                          key={tool.id}
                          className={`tool ${on ? "on" : ""} ${auto ? "auto" : ""}`}
                          onClick={() => toggle(tool.id)}
                        >
                          <span className="tool-check">{(on || auto) && <Check size={13} />}</span>
                          <span className="tool-body">
                            <strong>{tool.name}</strong>
                            <span className="muted small">{tool.summary}</span>
                          </span>
                          <span className="muted small">{tool.memoryMb} MB</span>
                        </button>
                      )
                    })}
                </div>
              </section>
            ))}

            {autoDeps.length > 0 && (
              <p className="note">
                Also installing {autoDeps.map(t => t.name).join(", ")} — needed by what you picked.
              </p>
            )}
          </div>
        )}

        {catalog && step === 1 && (
          <div className="wizard-body">
            <h3>Size</h3>
            <p className="muted small">Your selection needs about {needed} MB once the OS has taken its share.</p>
            <div className="choice-grid">
              {sizes.map(s => {
                const tight = s.memoryMb < needed
                const paid = covered(s.slug)
                const price = billing?.plans.find(p => p.size === s.slug)
                return (
                  <button
                    type="button"
                    key={s.slug}
                    disabled={tight}
                    className={`choice ${size === s.slug ? "on" : ""} ${tight ? "off" : ""} ${
                      !tight && !paid ? "needs-sub" : ""
                    }`}
                    onClick={() => setSize(s.slug)}
                  >
                    <strong>{s.label}</strong>
                    <span className="muted small">${price?.monthly ?? s.monthly}/mo</span>
                    {tight && <span className="muted small">Too small for this selection</span>}
                    {!tight && !paid && <span className="muted small">Subscribe to this size</span>}
                  </button>
                )
              })}
            </div>

            <h3>Shell</h3>
            <p className="muted small">
              What a terminal opens into, and what tools are launched under — so your aliases and rc files apply.
            </p>
            <div className="choice-grid">
              {(Object.keys(SHELLS) as ShellName[]).map(key => (
                <button
                  type="button"
                  key={key}
                  className={`choice ${shell === key ? "on" : ""}`}
                  onClick={() => setShell(key)}
                >
                  <strong>{SHELLS[key].label}</strong>
                  <span className="muted small">
                    {SHELLS[key].tool ? "Installed with the box" : "Already on the image"}
                  </span>
                </button>
              ))}
            </div>

            <h3>Project memory</h3>
            <p className="muted small">
              Synapse carries the decisions and conventions you have already recorded, so an agent here starts knowing
              what one on your laptop knows.
            </p>
            <div className="choice-grid">
              <button type="button" className={`choice ${synapse ? "" : "on"}`} onClick={() => setSynapse(false)}>
                <strong>This box only</strong>
                <span className="muted small">Nothing leaves the machine</span>
              </button>
              <button type="button" className={`choice ${synapse ? "on" : ""}`} onClick={() => setSynapse(true)}>
                <strong>Share with Synapse</strong>
                <span className="muted small">Needs Synapse set up on your account</span>
              </button>
            </div>

            <h3>Region</h3>
            <p className="muted small">Pick the one nearest you — it is the round trip you feel.</p>
            <div className="choice-grid">
              {catalog.regions.map(r => (
                <button
                  type="button"
                  key={r.slug}
                  className={`choice ${region === r.slug ? "on" : ""}`}
                  onClick={() => setRegion(r.slug)}
                >
                  <strong>{r.label}</strong>
                </button>
              ))}
            </div>
          </div>
        )}

        {catalog && step === 2 && (
          <div className="wizard-body">
            <dl className="summary">
              <dt>Name</dt>
              {/* The server's own fallback, shown rather than left blank —
                  the summary is the last chance to notice the box is about to
                  be called "box". */}
              <dd>{name.trim() || "box"}</dd>
              <dt>Size</dt>
              <dd>
                {sizes.find(s => s.slug === size)?.label} · ${sizes.find(s => s.slug === size)?.monthly}/mo
              </dd>
              <dt>Shell</dt>
              <dd>{SHELLS[shell].label}</dd>
              <dt>Memory</dt>
              <dd>{synapse ? "Synapse, shared with your other machines" : "This box only"}</dd>
              <dt>Region</dt>
              <dd>{catalog.regions.find(r => r.slug === region)?.label}</dd>
              <dt>Installing</dt>
              <dd>{resolved.map(t => t.name).join(", ")}</dd>
            </dl>
            {covered(size) ? (
              <p className="note">
                Setting up takes a few minutes. You can close this — the box will finish on its own and appear in the
                sidebar when it is ready.
              </p>
            ) : (
              <p className="note warn">
                Nothing is charged until you subscribe, and the box is created after that. One subscription covers one
                box of this size.
              </p>
            )}
          </div>
        )}

        <footer>
          {step > 0 && (
            <button type="button" className="ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <span className="grow" />
          {step < 2 ? (
            <button type="button" onClick={() => setStep(step + 1)} disabled={!catalog}>
              Continue
            </button>
          ) : covered(size) ? (
            <button type="button" onClick={create} disabled={busy}>
              {busy ? "Creating…" : "Create box"}
            </button>
          ) : (
            <button type="button" onClick={subscribe} disabled={busy}>
              {busy ? "…" : `Subscribe · $${billing?.plans.find(p => p.size === size)?.monthly}/mo`}
            </button>
          )}
        </footer>
      </dialog>
    </div>
  )
}
