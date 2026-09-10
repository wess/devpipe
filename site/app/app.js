/**
 * app.devpipe.com — sign in, then how to connect a machine.
 *
 * A file rather than an inline block because the Content-Security-Policy on
 * this origin has no `'unsafe-inline'` for scripts, and that is the thing
 * standing between an injected script and a session it can act with. The
 * session cookie is HttpOnly, so nothing here ever touches the token.
 *
 * Everything talks to `/api/*` on this same origin, which Caddy proxies to the
 * API. Same-origin on purpose: cookie-authenticated requests are origin-checked
 * by the API, and a cross-origin fetch would be refused — correctly.
 */

const $ = id => document.getElementById(id)

const show = which => {
  $("signin").hidden = which !== "signin"
  $("connect").hidden = which !== "connect"
}

const ask = async (path, options) => {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
    // Without this the browser sends no cookie and every request looks signed
    // out, which is a confusing way to discover a one-word omission.
    credentials: "same-origin",
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

const enter = person => {
  $("who").textContent = person?.email ?? person?.username ?? "you"
  show("connect")
}

const start = async () => {
  const { ok, body } = await ask("/api/auth/me")
  if (ok) return enter(body?.user ?? body)
  show("signin")
  $("email").focus()
}

$("form").addEventListener("submit", async event => {
  event.preventDefault()
  const button = $("submit")
  const problem = $("error")
  problem.textContent = ""
  button.disabled = true
  button.textContent = "Signing in…"

  try {
    const { ok, body } = await ask("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: $("email").value, password: $("password").value }),
    })
    if (!ok) {
      // The API's own sentence when it has one. It knows whether this was a
      // wrong password or a locked account; inventing a friendlier message here
      // would only be less true.
      problem.textContent = body?.error ?? "That did not work."
      return
    }
    const me = await ask("/api/auth/me")
    enter(me.ok ? (me.body?.user ?? me.body) : null)
  } catch {
    problem.textContent = "Could not reach the server."
  } finally {
    button.disabled = false
    button.textContent = "Sign in"
  }
})

$("signout").addEventListener("click", async () => {
  await ask("/api/auth/logout", { method: "POST" }).catch(() => {})
  show("signin")
  $("password").value = ""
})

start()
