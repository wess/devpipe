import { escapeHtml, layout, linkBlock, type RenderedEmail } from "./layout.ts"

export const paymentFailedEmail = (input: {
  name?: string | null
  updateUrl: string
  /** Already formatted, currency and all — this template does no arithmetic. */
  amount?: string | null
  /** Whatever the card network said, if it said anything useful. */
  reason?: string | null
  graceDays?: number
}): RenderedEmail => {
  const greeting = input.name?.trim() || "there"
  const days = input.graceDays ?? 3
  const amount = input.amount?.trim() || ""
  const reason = input.reason?.trim() || ""
  const subject = "Your Devpipe payment did not go through"

  const attempt = amount ? `The charge for ${amount} was declined.` : "The last charge on your card was declined."
  const because = reason ? ` The bank said: ${reason}.` : ""
  const grace = `Your boxes keep running for ${days} ${days === 1 ? "day" : "days"}. After that they are powered off and anything running in a session on them stops.`

  const text = [
    `Hi ${greeting},`,
    "",
    `${attempt}${because}`,
    "",
    "Update your card here and we will try again:",
    input.updateUrl,
    "",
    grace,
    "",
    "— Devpipe",
  ].join("\n")

  const body = `
    <p>Hi ${escapeHtml(greeting)},</p>
    <p>${escapeHtml(attempt)}${escapeHtml(because)}</p>
    ${linkBlock(input.updateUrl, "Update your card")}
    <p class="quiet">${escapeHtml(grace)}</p>
  `

  return { subject, html: layout({ title: subject, body }), text }
}
