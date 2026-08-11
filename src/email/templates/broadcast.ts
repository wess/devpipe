import { escapeHtml, layout, type RenderedEmail } from "./layout.ts"

/**
 * An announcement to people who claimed a username.
 *
 * The owner writes plain text, not markup — a compose box that accepts HTML is
 * a way to send a broken email to everyone at once, and there is no send to
 * take back. Paragraphs are the only structure, and they come from blank
 * lines.
 */
export const broadcastEmail = (input: {
  subject: string
  body: string
  siteUrl: string
  /** Set on a preview so the owner can tell it apart in their own inbox. */
  preview?: boolean
}): RenderedEmail => {
  const subject = input.preview ? `[preview] ${input.subject}` : input.subject

  const paragraphs = input.body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)

  const footer = input.preview
    ? "Preview only. Nobody else received this."
    : `You are receiving this because you claimed a username at ${input.siteUrl}.`

  const text = [...paragraphs, "", "—", footer, "", "— Devpipe"].join("\n\n")

  const html = layout({
    title: input.subject,
    body: `${paragraphs.map(p => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`).join("\n")}
      <p style="margin:24px 0 0;color:#6B7688;font-size:13px">${escapeHtml(footer)}</p>`,
  })

  return { subject, html, text }
}
