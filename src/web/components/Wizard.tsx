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

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export const Wizard: React.FC<{ onClose: () => void; onCreated: (id: number) => void }> = ({ onClose, onCreated }) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [spend, setSpend] = useState<api.MySpend | null>(null)
  const [step, setStep] = useState(0)
  // Empty rather than "My box". A prefilled name is a name nobody changes, and
  // the server falls back to "box" if this is left alone anyway.
  const [name, setName] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [shell, setShell] = useState<ShellName>("bash")
  const [synapse, setSynapse] = useState(false)
  const [region, setRegion] = useState("nyc3")
  const [size, setSize] = useState("")
  // GPU is a deliberate detour, not the default. Somebody who wants one knows
  // they want one; everybody else should never be shown a tile that costs more
  // per hour than the ordinary boxes cost per month.
  const [gpuMode, setGpuMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<api.Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<number | null>(null)
  const [newWorkspace, setNewWorkspace] = useState(false)
  const [workspaceName, setWorkspaceName] = useState("")
  const [workspaceGb, setWorkspaceGb] = useState(10)

  const refreshSpend = useCallback(() => api.mySpend().then(setSpend), [])

  useEffect(() => {
    api
      .catalog()
      .then(c => {
        setCatalog(c)
        setPicked(new Set(c.defaults))
        setRegion(c.regions[0]?.slug ?? "nyc3")
      })
      .catch(e => setError(String(e.message)))
    // What everything has cost so far, so a size can say what it adds. Never
    // blocks the wizard: a box is still creatable when this fails.
    void refreshSpend().catch(() => {})
    // Nobody has one on their first box, and an empty list is the normal case
    // rather than a failure — so this never blocks the wizard either.
    void api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {})
  }, [refreshSpend])

  /**
   * A workspace decides the region, rather than the other way round.
   *
   * Block storage is pinned where it was made, so a box elsewhere cannot mount
   * it. Letting both be picked freely means building the region control that
   * says no — moving it is the same rule with nothing to refuse.
   */
  const chosen = workspaces.find(w => w.id === workspaceId) ?? null
  useEffect(() => {
    if (chosen && chosen.region !== region) setRegion(chosen.region)
  }, [chosen, region])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

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
  const gpuList = catalog?.gpu_sizes ?? []
  const gpu = gpuMode ? (gpuList.find(g => g.slug === size) ?? null) : null
  const smallestThatFits = sizes.find(s => s.memoryMb >= needed)

  useEffect(() => {
    // A GPU box has more memory than the whole catalogue asks for, so this
    // rule has nothing to say about one — and left unguarded it would drag the
    // selection back to a CPU size the moment a card was picked.
    if (gpuMode) return
    // Follow the selection rather than stranding the user on a size that no
    // longer fits what they picked.
    if (smallestThatFits && !sizes.find(s => s.slug === size && s.memoryMb >= needed)) {
      setSize(smallestThatFits.slug)
    }
  }, [gpuMode, smallestThatFits, needed, size, sizes])

  /**
   * A card is only in one or two datacentres, so choosing one chooses where
   * the box lives. Moved rather than refused: a region left at its default is
   * not a decision anybody made, and failing the create over it teaches
   * nothing.
   */
  useEffect(() => {
    if (!gpu) return
    if (!gpu.regions.includes(region)) setRegion(gpu.regions[0])
  }, [gpu, region])

  /**
   * And a workspace cannot follow it. Block storage stays where it was made,
   * so a workspace in New York and a card only sold in Toronto are two answers
   * that cannot both stand — the newer one wins.
   */
  useEffect(() => {
    if (!gpu || workspaceId === null) return
    const w = workspaces.find(x => x.id === workspaceId)
    if (w && !gpu.regions.includes(w.region)) setWorkspaceId(null)
  }, [gpu, workspaceId, workspaces])

  /** What this size adds to the instance's bill, for the summary to say so. */
  const perDay = gpu ? (gpu.cents_per_hour * 24) / 100 : 0
  const capLeft = spend && spend.cap_cents > 0 ? spend.cap_cents - spend.instance_spent_cents : null

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
      // The workspace first, because the box asks for one by id. If this half
      // fails there is no box and no charge; if it succeeded and the box did
      // not, the workspace is in the list to pick next time rather than an
      // orphan nobody can see.
      let useWorkspace = workspaceId
      if (newWorkspace) {
        const made = await api.createWorkspace({
          name: workspaceName.trim() || "main",
          region,
          size_gb: workspaceGb,
        })
        useWorkspace = made.id
        setWorkspaces(list => [made, ...list])
        setWorkspaceId(made.id)
        setNewWorkspace(false)
      }
      const box = await api.createBox({
        name,
        region,
        size,
        shell,
        synapse,
        tools: [...picked],
        workspace_id: useWorkspace,
      })
      onCreated(box.id)
    } catch (e: any) {
      setError(String(e.message))
      // 409 is the instance's spending cap, reached between the check and the
      // create. Re-reading is what makes the figure in the footer agree with
      // the refusal.
      if (e.status === 409) await refreshSpend().catch(() => {})
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
            {gpuList.length > 0 && (
              <div className="choice-grid two">
                <button
                  type="button"
                  className={`choice ${gpuMode ? "" : "on"}`}
                  onClick={() => {
                    setGpuMode(false)
                    setSize(smallestThatFits?.slug ?? sizes[0]?.slug ?? "")
                  }}
                >
                  <strong>Ordinary box</strong>
                  <span className="muted small">Billed monthly, sized by what you installed</span>
                </button>
                <button
                  type="button"
                  className={`choice ${gpuMode ? "on" : ""}`}
                  onClick={() => {
                    setGpuMode(true)
                    setSize(gpuList[0].slug)
                  }}
                >
                  <strong>GPU box</strong>
                  <span className="muted small">Costs by the hour, from {money(gpuList[0].cents_per_hour)}/hr</span>
                </button>
              </div>
            )}
            {gpuMode ? (
              <p className="muted small">
                Charged by the hour against your balance, from the moment the machine exists until it is asleep or gone.
                It sleeps itself after an hour with nothing running, and your files stay on its workspace.
              </p>
            ) : (
              <p className="muted small">Your selection needs about {needed} MB once the OS has taken its share.</p>
            )}
            <div className="choice-grid">
              {gpuMode &&
                gpuList.map(g => (
                  <button
                    type="button"
                    key={g.slug}
                    className={`choice ${size === g.slug ? "on" : ""}`}
                    onClick={() => setSize(g.slug)}
                  >
                    <strong>{g.label}</strong>
                    <span className="muted small">{money(g.cents_per_hour)}/hr</span>
                    <span className="muted small">
                      {g.vram_gb} GB VRAM · {g.vcpus} vCPU · {Math.round(g.memory_mb / 1024)} GB RAM
                    </span>
                    <span className="muted small">
                      {g.regions.map(slug => catalog.regions.find(r => r.slug === slug)?.label ?? slug).join(", ")}
                    </span>
                  </button>
                ))}
              {!gpuMode &&
                sizes.map(s => {
                  const tight = s.memoryMb < needed
                  return (
                    <button
                      type="button"
                      key={s.slug}
                      disabled={tight}
                      className={`choice ${size === s.slug ? "on" : ""} ${tight ? "off" : ""}`}
                      onClick={() => setSize(s.slug)}
                    >
                      <strong>{s.label}</strong>
                      <span className="muted small">${s.monthly}/mo</span>
                      {tight && <span className="muted small">Too small for this selection</span>}
                    </button>
                  )
                })}
            </div>

            {gpu && (
              <p className="note warn">
                {money(gpu.cents_per_hour)} an hour — about ${perDay.toFixed(2)} a day — on this instance's DigitalOcean
                account.
                {capLeft !== null && ` ${money(capLeft)} is left under its cap this month.`} It puts itself to sleep
                after an hour with nothing running.
              </p>
            )}

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

            <h3>Storage</h3>
            <p className="muted small">
              A workspace keeps your files when the box goes. Without one, destroying a box takes the work on it with
              the machine.
            </p>
            <div className="choice-grid">
              <button
                type="button"
                className={`choice ${workspaceId === null && !newWorkspace ? "on" : ""}`}
                onClick={() => {
                  setWorkspaceId(null)
                  setNewWorkspace(false)
                }}
              >
                <strong>None</strong>
                <span className="muted small">Files live on the box</span>
              </button>
              {workspaces.map(w => {
                // Held by a live box: a volume mounts to one machine at a time,
                // so this is not a thing to discover after paying for a box.
                const held = w.attached_to !== null
                // Or in a datacentre this card is not sold in, which cannot be
                // fixed by moving either half.
                const elsewhere = Boolean(gpu && !gpu.regions.includes(w.region))
                return (
                  <button
                    type="button"
                    key={w.id}
                    disabled={held || elsewhere}
                    className={`choice ${workspaceId === w.id ? "on" : ""} ${held || elsewhere ? "off" : ""}`}
                    onClick={() => {
                      setWorkspaceId(w.id)
                      setNewWorkspace(false)
                    }}
                  >
                    <strong>{w.name}</strong>
                    <span className="muted small">
                      {w.size_gb} GB · {catalog.regions.find(r => r.slug === w.region)?.label ?? w.region}
                    </span>
                    {held && <span className="muted small">On another box</span>}
                    {!held && elsewhere && <span className="muted small">Not where this card is</span>}
                  </button>
                )
              })}
              <button
                type="button"
                className={`choice ${newWorkspace ? "on" : ""}`}
                onClick={() => {
                  setNewWorkspace(true)
                  setWorkspaceId(null)
                }}
              >
                <strong>New workspace</strong>
                <span className="muted small">Made in {catalog.regions.find(r => r.slug === region)?.label}</span>
              </button>
            </div>

            {newWorkspace && (
              <div className="wizard-inline">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={workspaceName}
                    onChange={e => setWorkspaceName(e.target.value)}
                    maxLength={40}
                    placeholder="main"
                  />
                </label>
                <label className="field">
                  <span>Size</span>
                  <select value={workspaceGb} onChange={e => setWorkspaceGb(Number(e.target.value))}>
                    {[10, 25, 50, 100, 250].map(gb => (
                      <option key={gb} value={gb}>
                        {gb} GB · ${(gb * 0.1).toFixed(2)}/mo
                      </option>
                    ))}
                  </select>
                </label>
                <small className="muted">
                  Billed by the provider from the moment it exists, and it keeps costing while it holds your files —
                  that is the point of it. Delete it when you are done with the work.
                </small>
              </div>
            )}

            <h3>Region</h3>
            {chosen ? (
              <p className="muted small">
                Fixed to {catalog.regions.find(r => r.slug === chosen.region)?.label ?? chosen.region} by the workspace
                you picked — storage cannot move between regions.
              </p>
            ) : gpu ? (
              <p className="muted small">
                {gpu.label} is only in{" "}
                {gpu.regions.map(slug => catalog.regions.find(r => r.slug === slug)?.label ?? slug).join(" and ")} — the
                cards are where they are.
              </p>
            ) : (
              <p className="muted small">Pick the one nearest you — it is the round trip you feel.</p>
            )}
            <div className="choice-grid">
              {catalog.regions.map(r => {
                const off =
                  (chosen !== null && r.slug !== chosen.region) || Boolean(gpu && !gpu.regions.includes(r.slug))
                return (
                  <button
                    type="button"
                    key={r.slug}
                    disabled={off}
                    className={`choice ${region === r.slug ? "on" : ""} ${off ? "off" : ""}`}
                    onClick={() => setRegion(r.slug)}
                  >
                    <strong>{r.label}</strong>
                  </button>
                )
              })}
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
                {gpu ? (
                  <>
                    {gpu.label} · {money(gpu.cents_per_hour)}/hr
                  </>
                ) : (
                  <>
                    {sizes.find(s => s.slug === size)?.label} · ${sizes.find(s => s.slug === size)?.monthly}/mo
                  </>
                )}
              </dd>
              <dt>Shell</dt>
              <dd>{SHELLS[shell].label}</dd>
              <dt>Memory</dt>
              <dd>{synapse ? "Synapse, shared with your other machines" : "This box only"}</dd>
              <dt>Storage</dt>
              <dd>
                {newWorkspace
                  ? `New workspace "${workspaceName.trim() || "main"}" · ${workspaceGb} GB`
                  : chosen
                    ? `${chosen.name} · ${chosen.size_gb} GB`
                    : "None — files go with the box"}
              </dd>
              <dt>Region</dt>
              <dd>{catalog.regions.find(r => r.slug === region)?.label}</dd>
              <dt>Installing</dt>
              <dd>{resolved.map(t => t.name).join(", ")}</dd>
            </dl>
            {gpu ? (
              <p className="note warn">
                The clock starts when the machine does, not when it is ready — setting up is part of what it costs.
                About ${perDay.toFixed(2)} a day left running, and it sleeps itself after an hour idle so a forgotten
                box is a few dollars rather than a few hundred.
              </p>
            ) : (
              <p className="note">
                Setting up takes a few minutes. You can close this — the box will finish on its own and appear in the
                sidebar when it is ready.
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
          ) : (
            <button type="button" onClick={create} disabled={busy}>
              {busy ? "Creating…" : gpu ? `Create box · ${money(gpu.cents_per_hour)}/hr` : "Create box"}
            </button>
          )}
        </footer>
      </dialog>
    </div>
  )
}
