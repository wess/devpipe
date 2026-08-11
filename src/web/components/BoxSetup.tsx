import { Check, Loader2 } from "lucide-react"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import * as api from "../api.ts"

type Event = { id: number; phase: string; line: string; at: string }

/**
 * What a box is doing while it builds.
 *
 * A build takes several minutes. A spinner for that long is indistinguishable
 * from a box that has died, and when one does fail the first thing anyone
 * wants is the last thing it printed — so the log *is* the interface here,
 * rather than something hidden behind a details toggle.
 */
const PHASES: { key: string; label: string }[] = [
  { key: "system", label: "Preparing the system" },
  { key: "user", label: "Creating your account" },
  { key: "daemon", label: "Installing the daemon" },
  { key: "dns", label: "Waiting for DNS" },
  { key: "tls", label: "Getting a certificate" },
  { key: "done", label: "Finishing up" },
]

export const BoxSetup: React.FC<{ boxId: number; status: string }> = ({ boxId, status }) => {
  const [events, setEvents] = useState<Event[]>([])
  const [phase, setPhase] = useState("")
  const cursor = useRef(0)
  const tail = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    let live = true
    let quiet = 0

    const tick = async () => {
      try {
        const out = await api.boxEvents(boxId, cursor.current)
        if (!live) return
        if (out.events.length) {
          quiet = 0
          setStuck(false)
          cursor.current = out.events[out.events.length - 1].id
          setEvents(prev => [...prev, ...out.events].slice(-400))
          const last = out.events[out.events.length - 1]
          if (last.phase) setPhase(last.phase)
        } else {
          // Long gaps are normal — apt is slow — but silence past a couple of
          // minutes is worth saying out loud rather than leaving ambiguous.
          quiet += 1
          if (quiet > 60) setStuck(true)
        }
      } catch {
        /* the box may not have reported yet */
      }
    }
    void tick()
    const timer = setInterval(tick, 2000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [boxId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new output
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" })
  }, [events.length])

  const reachedIndex = PHASES.findIndex(p => p.key === phase)

  return (
    <div className="setup">
      <div className="setup-head">
        <Loader2 className="spin" size={15} />
        <span>{status === "failed" ? "Setup failed" : "Setting up your box"}</span>
      </div>

      <ol className="phases">
        {PHASES.map((p, i) => {
          const done = reachedIndex > i || status === "ready"
          const now = reachedIndex === i && status !== "ready"
          return (
            <li key={p.key} className={done ? "done" : now ? "now" : ""}>
              <span className="mark">
                {done ? <Check size={12} /> : now ? <Loader2 className="spin" size={12} /> : "·"}
              </span>
              {p.label}
            </li>
          )
        })}
      </ol>

      {stuck && (
        <p className="note warn">
          Nothing new for a couple of minutes. Long waits are normal while packages install, but if this does not move,
          the log below is what it was doing.
        </p>
      )}

      <div className="setup-log">
        {events.length === 0 && <div className="muted">Waiting for the box to start reporting…</div>}
        {events.map(e => (
          <div key={e.id} className={lineClass(e.line)}>
            {e.line}
          </div>
        ))}
        <div ref={tail} />
      </div>
    </div>
  )
}

/** Colours the lines the script marks, and leaves everything else plain. */
const lineClass = (line: string): string => {
  // ASCII markers, matching what the setup script emits — see cloudinit.ts for
  // why it does not use nicer characters.
  if (line.startsWith("[ok]")) return "log ok"
  if (line.startsWith("[!!]")) return "log bad"
  if (line.startsWith("==")) return "log phase"
  if (/^(E:|error|fatal)/i.test(line)) return "log bad"
  if (/^(W:|warning)/i.test(line)) return "log warn"
  return "log"
}
