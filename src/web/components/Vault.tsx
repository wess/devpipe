import { Eye, EyeOff, Loader2, Trash2 } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import * as api from "../api.ts"
import { when } from "../format.ts"

/**
 * The vault: what you keep, and what your boxes are allowed to do with it.
 *
 * The screen is built around one distinction, because getting it wrong is the
 * expensive mistake. A **value** is configuration your boxes read freely. A
 * **secret** is a credential they cannot read at all unless you grant a
 * specific box a specific entry — so the interface says that where the choice
 * is made, rather than leaving it to be discovered when something fails.
 *
 * Plaintext is never pre-loaded. The list carries names and kinds only, and a
 * value is fetched on demand — that call is audited server-side every time, and
 * a screen that eagerly read every secret would fill the audit log with reads
 * nobody performed, which is the same as having no audit log.
 */

type Draft = {
  scope: api.VaultScope
  scopeId: number
  name: string
  kind: api.VaultKind
  value: string
}

const EMPTY: Draft = { scope: "global", scopeId: 0, name: "", kind: "value", value: "" }

/** Mirrors the server's rule, so a bad name is refused without a round trip. */
const validName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)

export const Vault: React.FC = () => {
  const [entries, setEntries] = useState<api.VaultEntry[]>([])
  const [workspaces, setWorkspaces] = useState<api.Workspace[]>([])
  const [boxes, setBoxes] = useState<api.Box[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [shown, setShown] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null)

  const refresh = useCallback(
    () =>
      api
        .listVault()
        .then(setEntries)
        .catch(() => {})
        .finally(() => setLoading(false)),
    [],
  )

  useEffect(() => {
    void refresh()
    void api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {})
    void api
      .listBoxes()
      .then(setBoxes)
      .catch(() => {})
  }, [refresh])

  const keyOf = (e: { scope: string; scope_id: number; name: string }) => `${e.scope}:${e.scope_id}:${e.name}`

  const scopeLabel = useCallback(
    (scope: api.VaultScope, scopeId: number) => {
      if (scope === "global") return "Everywhere"
      if (scope === "workspace") return `Workspace · ${workspaces.find(w => w.id === scopeId)?.name ?? `#${scopeId}`}`
      return `Box · ${boxes.find(b => b.id === scopeId)?.name ?? `#${scopeId}`}`
    },
    [workspaces, boxes],
  )

  // Grouped by scope, widest first, so the shadowing reads top to bottom: an
  // entry further down is the one that wins for the box it names.
  const grouped = useMemo(() => {
    const order: Array<{ scope: api.VaultScope; title: string }> = [
      { scope: "global", title: "Everywhere" },
      { scope: "workspace", title: "Per workspace" },
      { scope: "box", title: "Per box" },
    ]
    return order
      .map(group => ({ ...group, items: entries.filter(e => e.scope === group.scope) }))
      .filter(group => group.items.length > 0)
  }, [entries])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!validName(draft.name)) {
      setNote({ kind: "bad", text: "Names start with a letter or underscore, then letters, digits or underscores." })
      return
    }
    if (!draft.value) {
      setNote({ kind: "bad", text: "Give it a value." })
      return
    }
    setBusy(true)
    try {
      await api.putVaultEntry({
        scope: draft.scope,
        scope_id: draft.scope === "global" ? 0 : draft.scopeId,
        name: draft.name,
        kind: draft.kind,
        value: draft.value,
      })
      // The scope and kind stay put: adding several entries to one place is the
      // common shape, and resetting them every time makes that tedious.
      setDraft({ ...EMPTY, scope: draft.scope, scopeId: draft.scopeId, kind: draft.kind })
      setNote({ kind: "ok", text: "Saved." })
      await refresh()
    } catch (error) {
      setNote({ kind: "bad", text: error instanceof Error ? error.message : "Could not save that." })
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (entry: api.VaultEntry) => {
    const key = keyOf(entry)
    if (shown[key] !== undefined) {
      // Hiding drops the plaintext rather than keeping it behind a boolean, so
      // it is not sitting in memory for the rest of the session.
      setShown(current => {
        const next = { ...current }
        delete next[key]
        return next
      })
      return
    }
    try {
      const full = await api.revealVaultEntry(entry.scope, entry.scope_id, entry.name)
      setShown(current => ({ ...current, [key]: full.value }))
    } catch (error) {
      setNote({ kind: "bad", text: error instanceof Error ? error.message : "Could not read that." })
    }
  }

  const remove = async (entry: api.VaultEntry) => {
    try {
      await api.deleteVaultEntry(entry.scope, entry.scope_id, entry.name)
      setShown(current => {
        const next = { ...current }
        delete next[keyOf(entry)]
        return next
      })
      await refresh()
    } catch (error) {
      setNote({ kind: "bad", text: error instanceof Error ? error.message : "Could not delete that." })
    }
  }

  return (
    <div className="page">
      <h1>Vault</h1>
      <p className="muted">
        Configuration and credentials your boxes can use. Everything here is available to the agents
        running on them, which is why the two kinds are not the same thing.
      </p>
      {note && <p className={`note ${note.kind === "bad" ? "bad" : "ok"}`}>{note.text}</p>}

      <section className="card">
        <h2>Add an entry</h2>
        <form onSubmit={save}>
          <label className="field">
            <span>Available to</span>
            <select
              value={draft.scope === "global" ? "global" : `${draft.scope}:${draft.scopeId}`}
              onChange={e => {
                const raw = e.target.value
                if (raw === "global") {
                  setDraft({ ...draft, scope: "global", scopeId: 0 })
                  return
                }
                const [scope, id] = raw.split(":")
                setDraft({ ...draft, scope: scope as api.VaultScope, scopeId: Number(id) })
              }}
            >
              <option value="global">Everywhere — all of your boxes</option>
              {workspaces.map(w => (
                <option key={`w${w.id}`} value={`workspace:${w.id}`}>
                  Workspace · {w.name}
                </option>
              ))}
              {boxes.map(b => (
                <option key={`b${b.id}`} value={`box:${b.id}`}>
                  Box · {b.name}
                </option>
              ))}
            </select>
            <small className="muted">
              A box reads the narrowest scope that defines a name: its own first, then its
              workspace's, then everywhere.
            </small>
          </label>

          <label className="field">
            <span>Kind</span>
            <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as api.VaultKind })}>
              <option value="value">Value — your boxes can read it</option>
              <option value="secret">Secret — boxes cannot read it unless granted</option>
            </select>
            <small className="muted">
              {draft.kind === "secret"
                ? "Stored encrypted and never handed to a box on its own. A box sees the name and can read the value only where you grant that box this entry."
                : "Stored encrypted, and any of your boxes in this scope can read it. Do not put a credential here."}
            </small>
          </label>

          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="OPENAI_API_KEY"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>Value</span>
            <input
              type="password"
              value={draft.value}
              onChange={e => setDraft({ ...draft, value: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <button type="submit" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : null} Save
          </button>
        </form>
      </section>

      <section className="card">
        <h2>What you keep</h2>
        {loading ? (
          <p className="muted">
            <Loader2 size={14} className="spin" /> Loading…
          </p>
        ) : entries.length === 0 ? (
          <p className="muted small">Nothing yet. Anything you add above appears here.</p>
        ) : (
          grouped.map(group => (
            <div key={group.scope}>
              <h3>{group.title}</h3>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Where</th>
                    <th>Used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {group.items.map(entry => {
                    const key = keyOf(entry)
                    const value = shown[key]
                    return (
                      <tr key={key}>
                        <td>
                          <code>{entry.name}</code>
                          <span className="pill">{entry.kind}</span>
                          {value !== undefined && (
                            <div className="muted small" style={{ wordBreak: "break-all", marginTop: ".3rem" }}>
                              {value}
                            </div>
                          )}
                        </td>
                        <td className="muted small">{scopeLabel(entry.scope, entry.scope_id)}</td>
                        <td className="muted small">
                          {entry.last_used_at ? when(entry.last_used_at) : "never"}
                        </td>
                        <td className="right">
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => void reveal(entry)}
                            aria-label={value === undefined ? `Show ${entry.name}` : `Hide ${entry.name}`}
                          >
                            {value === undefined ? <Eye size={14} /> : <EyeOff size={14} />}
                          </button>
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => void remove(entry)}
                            aria-label={`Delete ${entry.name}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>Using it from a box</h2>
        <p className="muted small">
          Every box carries a <code>devpipe</code> command and an MCP server, so an agent reaches
          what you keep here without you pasting anything into a prompt.
        </p>
        <pre>
          <code>{`devpipe value list          # names and kinds this box may use
devpipe value get NAME      # read a value, or a granted secret
devpipe value set NAME VAL  # write a value into this box's scope`}</code>
        </pre>
      </section>
    </div>
  )
}
