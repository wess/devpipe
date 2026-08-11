import { escapeHtml, layout, linkBlock, type RenderedEmail } from "./layout.ts"

export const inviteEmail = (input: {
  inviterName?: string | null
  signupUrl: string
  /** The code itself, for anyone who ends up on the sign-up form without it. */
  code?: string | null
  note?: string | null
}): RenderedEmail => {
  const inviter = input.inviterName?.trim() || "Someone"
  const subject = `${inviter} invited you to Devpipe`
  const code = input.code?.trim() || ""

  const text = [
    `${inviter} invited you to Devpipe — a Linux box that stays running, with coding-agent CLIs on it, reachable from a browser or an iPad.`,
    "",
    input.note ? `Their note:\n"${input.note}"\n` : null,
    "Sign up here:",
    input.signupUrl,
    "",
    code ? `If the form asks for an invite code, it is ${code}.` : null,
    "",
    "If you weren't expecting this, you can ignore the email.",
    "",
    "— Devpipe",
  ]
    .filter((line): line is string => line !== null)
    .join("\n")

  const noteBlock = input.note
    ? `<blockquote style="border-left: 3px solid #FFB454; padding: 4px 14px; color: #3B4252; margin: 16px 0; font-style: italic;">${escapeHtml(input.note)}</blockquote>`
    : ""
  const codeBlock = code
    ? `<p class="quiet">If the form asks for an invite code, it is <code>${escapeHtml(code)}</code>.</p>`
    : ""

  const body = `
    <p><strong>${escapeHtml(inviter)}</strong> invited you to Devpipe — a Linux box that stays running, with coding-agent CLIs on it, reachable from a browser or an iPad.</p>
    ${noteBlock}
    ${linkBlock(input.signupUrl, "Accept invite")}
    ${codeBlock}
    <p class="quiet">If you weren't expecting this, you can ignore the email.</p>
  `

  return { subject, html: layout({ title: subject, body }), text }
}
