import { Loader2 } from "lucide-react"
import type React from "react"
import { useEffect, useState } from "react"
import * as api from "../api.ts"
import { when } from "../format.ts"

/**
 * What your machines have cost.
 *
 * Nobody is billed for any of it — Devpipe runs on the DigitalOcean account of
 * whoever installed it, and the invoice goes to them. Which is exactly why
 * this screen exists for everybody rather than only for the owner: on an
 * instance shared by a team, the cost of a box left running over a weekend
 * would otherwise be visible to every person except the one who left it
 * running.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export const Spend: React.FC = () => {
  const [data, setData] = useState<api.MySpend | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .mySpend()
      .then(setData)
      .catch(e => setError(String(e.message)))
  }, [])

  if (!data) {
    return (
      <div className="page">{error ? <p className="note bad">{error}</p> : <Loader2 className="spin" size={16} />}</div>
    )
  }

  const perDay = (data.run_rate_cents_per_hour * 24) / 100

  return (
    <div className="page">
      <h1>Spending</h1>
      <p className="muted">
        DigitalOcean's own prices for your boxes and workspaces, counted from the moment each machine exists. Since{" "}
        {when(data.period_start)}.
      </p>
      {error && <p className="note bad">{error}</p>}

      <section className="card">
        <h2>This month</h2>
        <div className="price">
          {money(data.spent_cents)}
          <span> so far</span>
        </div>
        <p className="muted small">
          {data.run_rate_cents_per_hour > 0
            ? `Running at ${money(Math.round(data.run_rate_cents_per_hour))} an hour — about $${perDay.toFixed(2)} a day if nothing changes.`
            : "Nothing of yours is running right now."}
        </p>
        {data.cap_cents > 0 && (
          <p className="note">
            This instance has a {money(data.cap_cents)} cap for the month and has used{" "}
            {money(data.instance_spent_cents)} of it across everybody. Past the cap no new machines start and running
            ones are put to sleep with their files intact.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Where it went</h2>
        {data.entries.length === 0 ? (
          <p className="muted small">Nothing yet this month.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map(e => (
                <tr key={e.id}>
                  <td className="muted small">{when(e.created_at)}</td>
                  <td className="muted small">
                    {e.note || e.kind}
                    {e.kind === "workspace" && <span className="pill">storage</span>}
                  </td>
                  <td className="small">{money(e.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note">
          A workspace keeps costing while it holds your files — that is the point of it, and it is why a box can be put
          to sleep without losing anything. Delete one when you are done with the work on it.
        </p>
      </section>
    </div>
  )
}
