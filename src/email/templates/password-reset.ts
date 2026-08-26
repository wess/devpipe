import { escapeHtml, layout, linkBlock, type RenderedEmail } from "./layout.ts"

export const passwordResetEmail = (input: { name?: string | null; resetUrl: string }): RenderedEmail => {
  const greeting = input.name?.trim() || "there"
  const subject = "Reset your Devpipe password"

  const text = [
    `Hi ${greeting},`,
    "",
    "Someone asked to reset the password on your Devpipe account. Set a new one here:",
    "",
    input.resetUrl,
    "",
    "The link works once and expires in an hour. Setting a new password also signs out your browsers and CLI sessions.",
    "",
    "If this wasn't you, ignore this email. Your password stays as it is.",
    "",
    "— Devpipe",
  ].join("\n")

  const body = `
    <p>Hi ${escapeHtml(greeting)},</p>
    <p>Someone asked to reset the password on your Devpipe account. Set a new one below.</p>
    ${linkBlock(input.resetUrl, "Set a new password")}
    <p class="quiet">The link works once and expires in an hour. Setting a new password also signs out your browsers and CLI sessions.</p>
    <p class="quiet">If this wasn't you, ignore this email. Your password stays as it is.</p>
  `

  return { subject, html: layout({ title: subject, body }), text }
}
