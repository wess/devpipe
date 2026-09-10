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

/**
 * Ask the relay for a key.
 *
 * Over a websocket rather than a fetch, and that is the whole trick: the
 * session cookie is HttpOnly, so this script cannot read it or send it — but
 * the browser attaches it to the upgrade request anyway. The relay reads it
 * there and asks the app who it belongs to. Nothing sensitive passes through
 * JavaScript at any point.
 */
const mint = can =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${location.host}/relay`)
    socket.binaryType = "arraybuffer"

    // channel 0, opcode 0 (data) — the same five-byte header everything else
    // on this wire uses. See devpipe/src/proto.rs.
    const frame = body => {
      const payload = new TextEncoder().encode(JSON.stringify(body))
      const out = new Uint8Array(5 + payload.length)
      out.set(payload, 5)
      return out
    }

    socket.onopen = () => socket.send(frame({ type: "mint", can }))
    socket.onerror = () => reject(new Error("Could not reach the relay."))
    socket.onclose = () => reject(new Error("The relay closed without answering."))
    socket.onmessage = event => {
      const said = JSON.parse(new TextDecoder().decode(new Uint8Array(event.data).slice(5)))
      socket.close()
      if (said.type === "minted") resolve(said)
      else reject(new Error(said.message ?? "The relay refused."))
    }
  })

const shown = (can, said) => {
  const relay = `wss://${location.host}/relay`
  $("minted").textContent =
    can === "enrol"
      ? `# on the machine\ndevpipe serve --relay ${relay} \\\n  --relay-token ${said.token} --relay-name box-a`
      : `# on this laptop\ndp add box-a --relay ${relay} \\\n  --relay-token ${said.token} --token <the machine's own>`
  $("minted").hidden = false
  $("minted-note").hidden = false
}

for (const can of ["enrol", "reach"]) {
  $(`mint-${can}`).addEventListener("click", async event => {
    const button = event.currentTarget
    $("mint-error").textContent = ""
    button.disabled = true
    try {
      shown(can, await mint(can))
    } catch (e) {
      $("mint-error").textContent = e.message
    } finally {
      button.disabled = false
    }
  })
}

$("signout").addEventListener("click", async () => {
  await ask("/api/auth/logout", { method: "POST" }).catch(() => {})
  show("signin")
  $("password").value = ""
  // A key on screen belongs to the session that is ending.
  $("minted").hidden = true
  $("minted-note").hidden = true
  $("minted").textContent = ""
})

start()
