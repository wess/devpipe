import { escapeHtml, safeHref } from "@atlas/email"

export type RenderedEmail = { subject: string; html: string; text: string }

/** Templates import one file rather than two. */
export { escapeHtml, safeHref }

/**
 * The email shell.
 *
 * Not `layout` from @atlas/email: that one paints the button label a light
 * grey, and Devpipe's accent is amber, which nothing light is readable on.
 * The button here is the same amber-on-near-black as the app's own submit
 * buttons, so a link in an email looks like the thing it leads to.
 */
export const layout = (input: { title: string; body: string }): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      body { background: #F2F3F5; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #11151D; }
      .container { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
      .card { background: #ffffff; border: 1px solid #DDE1E7; border-radius: 12px; padding: 32px; }
      .brand { font-size: 26px; font-weight: 700; letter-spacing: -0.04em; margin: 0 0 24px; }
      .btn { display: inline-block; background: #FFB454; color: #10131A; text-decoration: none; padding: 12px 22px; border-radius: 7px; font-weight: 600; }
      .quiet { font-size: 13px; color: #6B7688; }
      .footer { text-align: center; font-size: 12px; color: #6B7688; margin-top: 24px; }
      a { color: #C2661F; }
      p { line-height: 1.55; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #F2F3F5; border: 1px solid #DDE1E7; border-radius: 5px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <p class="brand">devpipe</p>
        ${input.body}
      </div>
      <div class="footer">Devpipe &middot; persistent terminal sessions on a remote box</div>
    </div>
  </body>
</html>`

/**
 * A button and the same URL in full. The second half is not redundant: plenty
 * of clients strip the button, and some people would rather read a URL before
 * they follow it.
 */
export const linkBlock = (url: string, label: string): string => `
    <p style="margin: 24px 0;">
      <a href="${safeHref(url)}" class="btn">${escapeHtml(label)}</a>
    </p>
    <p class="quiet">Or paste this URL into your browser:<br>
      <a href="${safeHref(url)}" style="word-break: break-all;">${escapeHtml(url)}</a>
    </p>`
