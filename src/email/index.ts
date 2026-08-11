import type { Emailer, EmailMessage, SendResult } from "@atlas/email"
import { createEmailer as createAtlasEmailer } from "@atlas/email"

export { boxReadyEmail } from "./templates/box-ready.ts"
export { broadcastEmail } from "./templates/broadcast.ts"
export { inviteEmail } from "./templates/invite.ts"
export type { RenderedEmail } from "./templates/layout.ts"
export { passwordResetEmail } from "./templates/password-reset.ts"
export { paymentFailedEmail } from "./templates/payment-failed.ts"
export type { Emailer, EmailMessage, SendResult }

export type EmailConfig = {
  apiKey?: string | null
  from?: string | null
  /** A Resend-compatible host to send through — a self-hosted Outbox, say. */
  baseUrl?: string | null
  /** Keep messages in memory instead of printing them. Tests read `sent`. */
  record?: boolean
}

export type RecordingEmailer = Emailer & { readonly sent: EmailMessage[] }

/**
 * Records instead of sending, and records synchronously — a caller that fires
 * a send off without awaiting it (see `sendDetached`) has still recorded the
 * message by the time its own handler returns, so a test can assert on it
 * without a sleep.
 */
export const createRecordingEmailer = (): RecordingEmailer => {
  const sent: EmailMessage[] = []
  return {
    enabled: false,
    sent,
    send: (msg: EmailMessage): Promise<SendResult> => {
      sent.push(msg)
      return Promise.resolve({ ok: true, logged: true })
    },
  }
}

/**
 * A real sender when a key and a from address are both configured, and a driver
 * that prints to stdout when either is missing. Nothing leaves the machine unless
 * someone deliberately configured a sending domain, which is what keeps a
 * development instance from mailing a real person mid-experiment.
 */
export const createEmailer = (config: EmailConfig): Emailer => {
  if (config.record) return createRecordingEmailer()
  return createAtlasEmailer({ apiKey: config.apiKey, from: config.from, baseUrl: config.baseUrl })
}

/**
 * Sends without making the request wait.
 *
 * Two reasons. A provider round trip would make a route that has an address to
 * mail answer measurably slower than one that does not, which is exactly the
 * difference /auth/forgot exists to hide. And a mail provider being down is
 * not a reason to fail the thing the user actually asked for — the failure is
 * logged, not returned.
 */
export const sendDetached = (emailer: Emailer, msg: EmailMessage): void => {
  void emailer
    .send(msg)
    .then(result => {
      if (!result.ok) console.error(`[email] ${msg.subject}: ${result.error}`)
    })
    .catch(err => console.error("[email] send threw:", err))
}
