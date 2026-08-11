/**
 * The DigitalOcean side of provisioning.
 *
 * Everything here takes the token as an argument rather than reading it from a
 * module-level cache, so there is exactly one place that decides which token a
 * request runs under and it is visible at the call site.
 */

const API = "https://api.digitalocean.com/v2"

export type Droplet = {
  id: number
  name: string
  status: string
  ip: string
  region: string
  size: string
  memoryMb: number
  vcpus: number
  monthly: number
  tags: string[]
  createdAt: string
}

const request = async (token: string, path: string, init: RequestInit = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 204) return null
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      res.status === 401
        ? "DigitalOcean rejected the API token."
        : res.status === 422
          ? ((body as any)?.message ?? "DigitalOcean refused that request.")
          : res.status === 429
            ? "DigitalOcean is rate limiting us. Try again shortly."
            : `DigitalOcean returned ${res.status}.`
    throw new Error(message)
  }
  return body
}

const shape = (d: any): Droplet => ({
  id: d.id,
  name: d.name,
  status: d.status,
  // A droplet also carries a private address; reporting that as "the" IP
  // sends anyone who copies it nowhere.
  ip: d.networks?.v4?.find((n: any) => n.type === "public")?.ip_address ?? "",
  region: d.region?.slug ?? "",
  size: d.size?.slug ?? d.size_slug ?? "",
  memoryMb: d.memory ?? 0,
  vcpus: d.vcpus ?? 0,
  monthly: d.size?.price_monthly ?? 0,
  tags: d.tags ?? [],
  createdAt: d.created_at ?? "",
})

export const verifyToken = async (token: string) => {
  const body: any = await request(token, "/account")
  return {
    email: body?.account?.email ?? "",
    dropletLimit: body?.account?.droplet_limit ?? 0,
    status: body?.account?.status ?? "",
  }
}

export const listDroplets = async (token: string): Promise<Droplet[]> => {
  const body: any = await request(token, "/droplets?per_page=200")
  return (body?.droplets ?? []).map(shape)
}

export const getDroplet = async (token: string, id: number): Promise<Droplet | null> => {
  try {
    const body: any = await request(token, `/droplets/${id}`)
    return body?.droplet ? shape(body.droplet) : null
  } catch {
    return null
  }
}

export const createDroplet = async (
  token: string,
  opts: {
    name: string
    region: string
    size: string
    image?: string
    userData: string
    sshKeyIds?: number[]
    tags?: string[]
  },
): Promise<Droplet> => {
  const body: any = await request(token, "/droplets", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      region: opts.region,
      size: opts.size,
      image: opts.image ?? "debian-13-x64",
      user_data: opts.userData,
      ssh_keys: opts.sshKeyIds ?? [],
      tags: opts.tags ?? ["devpipe"],
      monitoring: true,
    }),
  })
  return shape(body.droplet)
}

export const destroyDroplet = async (token: string, id: number): Promise<void> => {
  await request(token, `/droplets/${id}`, { method: "DELETE" })
}

// ---- Firewall -------------------------------------------------------------

/**
 * What may be reached on a box from the internet.
 *
 * A box is a public droplet with a public address, and the person using it has
 * passwordless sudo and an agent that runs whatever it decides to run. The
 * packages in the catalogue happen to bind loopback by default today —
 * Debian's postgres and redis both do — but that is their default, not a
 * property of the box, and one `docker run -p 5432:5432`, one `python -m
 * http.server`, one dev server bound to 0.0.0.0 puts a service on the public
 * internet without anybody deciding to.
 *
 * This is enforced by DigitalOcean, outside the droplet, which is the point.
 * A firewall *on* the box could be turned off by the box — and Docker writes
 * its own iptables rules that bypass ufw entirely, so on the one tool most
 * likely to publish a port, a host firewall is not a control at all.
 *
 * Attached by tag, so it covers every droplet carrying it: the box being
 * created now, and any created later by a process that never calls this.
 */
const ANYWHERE = ["0.0.0.0/0", "::/0"]

export const BOX_FIREWALL_NAME = "devpipe-boxes"

export const boxFirewallSpec = (tag: string) => ({
  name: BOX_FIREWALL_NAME,
  inbound_rules: [
    // Getting onto a box that wedged during setup. Key-only — the images
    // ship with password authentication off — and it is the only way in when
    // the daemon is the thing that is broken.
    { protocol: "tcp", ports: "22", sources: { addresses: ANYWHERE } },
    // Let's Encrypt's HTTP-01 challenge. Without it the box never gets a
    // certificate, and without a certificate iOS will not talk to it at all.
    { protocol: "tcp", ports: "80", sources: { addresses: ANYWHERE } },
    // Caddy, and through it the daemon. 7788 is deliberately absent: the
    // daemon binds loopback and is only ever reached through the proxy.
    { protocol: "tcp", ports: "443", sources: { addresses: ANYWHERE } },
  ],
  // Unrestricted. A box exists to fetch packages, clone repositories and let
  // an agent call an API; egress filtering here would break the product and
  // stop nothing, since anything running on the box can reach the internet
  // through the ports we would have to leave open anyway.
  outbound_rules: [
    { protocol: "tcp", ports: "all", destinations: { addresses: ANYWHERE } },
    { protocol: "udp", ports: "all", destinations: { addresses: ANYWHERE } },
    { protocol: "icmp", destinations: { addresses: ANYWHERE } },
  ],
  tags: [tag],
})

/**
 * Creates the firewall, or puts it back the way it should be.
 *
 * Converged on every provision rather than created once. The failure this
 * guards against is not "no firewall" — that is loud — but a rule added in the
 * console during an afternoon's debugging and never taken out again.
 */
export const ensureBoxFirewall = async (token: string, tag = "devpipe"): Promise<string> => {
  const spec = boxFirewallSpec(tag)
  const body: any = await request(token, "/firewalls?per_page=200")
  const existing = (body?.firewalls ?? []).find((f: any) => f.name === BOX_FIREWALL_NAME)
  if (existing) {
    await request(token, `/firewalls/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(spec),
    })
    return String(existing.id)
  }
  const made: any = await request(token, "/firewalls", {
    method: "POST",
    body: JSON.stringify(spec),
  })
  return String(made?.firewall?.id ?? "")
}

// ---- DNS ------------------------------------------------------------------

export const upsertRecord = async (token: string, domain: string, name: string, ip: string): Promise<number> => {
  const body: any = await request(token, `/domains/${domain}/records?per_page=200&type=A`)
  const existing = (body?.domain_records ?? []).find((r: any) => r.name === name)
  if (existing) {
    await request(token, `/domains/${domain}/records/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ data: ip }),
    })
    return existing.id
  }
  const created: any = await request(token, `/domains/${domain}/records`, {
    method: "POST",
    body: JSON.stringify({ type: "A", name, data: ip, ttl: 300 }),
  })
  return created.domain_record.id
}

export const deleteRecord = async (token: string, domain: string, name: string): Promise<void> => {
  const body: any = await request(token, `/domains/${domain}/records?per_page=200&type=A`)
  const existing = (body?.domain_records ?? []).find((r: any) => r.name === name)
  if (existing) {
    await request(token, `/domains/${domain}/records/${existing.id}`, { method: "DELETE" })
  }
}

export const listSshKeys = async (token: string) => {
  const body: any = await request(token, "/account/keys")
  return (body?.ssh_keys ?? []).map((k: any) => ({ id: k.id, name: k.name }))
}
