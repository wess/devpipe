import { escapeHtml, layout, linkBlock, type RenderedEmail } from "./layout.ts"

export const boxReadyEmail = (input: {
  name?: string | null
  boxName: string
  hostname: string
  url: string
  tools?: readonly string[]
}): RenderedEmail => {
  const greeting = input.name?.trim() || "there"
  const subject = `Your box ${input.boxName} is ready`
  const tools = (input.tools ?? []).filter(t => t.trim().length > 0)

  const text = [
    `Hi ${greeting},`,
    "",
    `${input.boxName} finished provisioning and is answering at ${input.hostname}.`,
    "",
    tools.length ? `Installed: ${tools.join(", ")}.` : null,
    "",
    "Open a terminal on it:",
    input.url,
    "",
    "The box runs, and is billed, until you destroy it from the box list.",
    "",
    "— Devpipe",
  ]
    .filter((line): line is string => line !== null)
    .join("\n")

  const toolsBlock = tools.length ? `<p class="quiet">Installed: ${escapeHtml(tools.join(", "))}.</p>` : ""

  const body = `
    <p>Hi ${escapeHtml(greeting)},</p>
    <p><strong>${escapeHtml(input.boxName)}</strong> finished provisioning and is answering at <code>${escapeHtml(input.hostname)}</code>.</p>
    ${toolsBlock}
    ${linkBlock(input.url, "Open a terminal")}
    <p class="quiet">The box runs, and is billed, until you destroy it from the box list.</p>
  `

  return { subject, html: layout({ title: subject, body }), text }
}
