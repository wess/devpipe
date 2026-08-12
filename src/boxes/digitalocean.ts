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

/**
 * Snapshots a powered-off droplet and waits for the image to exist.
 *
 * Waited on rather than fired off: the caller's next act is to destroy the
 * droplet this was taken from, and a snapshot action that is still running when
 * its source disappears is a snapshot that does not finish.
 */
export const snapshotDroplet = async (token: string, id: number, name: string): Promise<number> => {
  const body: any = await request(token, `/droplets/${id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "snapshot", name }),
  })
  const actionId = body?.action?.id
  if (!actionId) throw new Error("DigitalOcean did not start the snapshot.")

  // Snapshots of a several-gigabyte disk take minutes, not seconds.
  for (let i = 0; i < 120; i++) {
    const status: any = await request(token, `/droplets/${id}/actions/${actionId}`)
    const state = status?.action?.status
    if (state === "completed") break
    if (state === "errored") throw new Error("DigitalOcean could not take that snapshot.")
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }

  const images: any = await request(token, "/images?private=true&per_page=200")
  const image = (images?.images ?? []).find((i: any) => i.name === name)
  if (!image) throw new Error("The snapshot completed but no image with that name appeared.")
  return image.id as number
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
  // Open except for mail.
  //
  // A box exists to fetch packages, clone repositories and let an agent call an
  // API, so egress is otherwise unrestricted — filtering it would break the
  // product and stop very little, since anything on the box can reach the
  // internet through the ports that have to stay open anyway.
  //
  // Mail is the exception because it is the one abuse that costs *other*
  // customers their machines. A box that relays spam gets the complaint sent to
  // the provider account every box is created under, and the provider's remedy
  // is to lock that account — see the note at the top of security/abuse.ts.
  // Nothing in this product needs to speak SMTP from a box, so 25, 465 and 587
  // are the cheapest thing here: no legitimate use lost, and the fastest route
  // from one bad customer to everyone's box being gone is closed.
  //
  // Written as the ranges around those ports because DigitalOcean's rules say
  // what is allowed rather than what is denied.
  outbound_rules: [
    { protocol: "tcp", ports: "1-24", destinations: { addresses: ANYWHERE } },
    { protocol: "tcp", ports: "26-464", destinations: { addresses: ANYWHERE } },
    { protocol: "tcp", ports: "466-586", destinations: { addresses: ANYWHERE } },
    { protocol: "tcp", ports: "588-65535", destinations: { addresses: ANYWHERE } },
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
/**
 * The tag the firewall follows.
 *
 * Deliberately not "devpipe". The control plane carries that tag too, so a
 * firewall attached to it covers the machine running the API — which is how
 * closing outbound mail on boxes silently stopped the control plane from
 * sending a password reset. A box is a box; the host that provisions them is
 * not one, and the rules that suit one are wrong for the other.
 */
export const BOX_TAG = "devpipe-box"

export const ensureBoxFirewall = async (token: string, tag = BOX_TAG): Promise<string> => {
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

// ---- bandwidth --------------------------------------------------------------

/**
 * Outbound public bandwidth for a droplet, as an average over the window.
 *
 * The only measurement here that bounds abuse rather than inconveniencing it.
 * The apt pin and the closed mail ports are friction: they raise the cost of
 * the obvious thing and stop nobody who tries twice. Volume is different — a
 * box that has pushed hundreds of gigabytes is a seedbox or a mirror whatever
 * software it used to do it, and that is a judgement the control plane can make
 * without ever looking at what runs on the box.
 *
 * Returns megabits per second averaged across the samples, and `null` when
 * DigitalOcean has no data — a droplet created minutes ago has none, and a
 * missing reading must never read as a quiet box.
 */
export const outboundMbps = async (token: string, dropletId: string, windowSeconds = 3600): Promise<number | null> => {
  const end = Math.floor(Date.now() / 1000)
  const start = end - windowSeconds
  const query = new URLSearchParams({
    host_id: dropletId,
    interface: "public",
    direction: "outbound",
    start: String(start),
    end: String(end),
  })
  const body: any = await request(token, `/monitoring/metrics/droplet/bandwidth?${query}`)
  const values: [number, string][] = body?.data?.result?.[0]?.values ?? []
  if (values.length === 0) return null
  const total = values.reduce((sum, [, value]) => sum + Number(value), 0)
  return total / values.length
}

/** Megabits per second to gigabytes over the same window. */
export const gigabytesOver = (mbps: number, windowSeconds: number): number => (mbps * windowSeconds) / 8 / 1000

// ---- volumes ----------------------------------------------------------------

/**
 * Block storage that outlives the machine it is attached to.
 *
 * A box is meant to be disposable — the manifest rebuilds one identically, which
 * is what makes destroying it survivable. What it does not rebuild is the work:
 * the destroy dialog says so outright, and it is the one thing on a box nobody
 * can replace. A volume is how "destroy the machine, keep the work" becomes true
 * rather than a wish.
 *
 * Two properties decide everything about how this is used:
 *
 * - A volume attaches to exactly one droplet at a time. Two boxes cannot share
 *   one, and a volume still attached to a droplet cannot be attached to another.
 * - A volume is pinned to a region. A workspace therefore has a region, and a
 *   box created elsewhere cannot mount it.
 */
export type Volume = {
  id: string
  name: string
  region: string
  sizeGb: number
  dropletIds: number[]
}

const volume = (v: any): Volume => ({
  id: v.id,
  name: v.name,
  region: v.region?.slug ?? "",
  sizeGb: v.size_gigabytes ?? 0,
  dropletIds: v.droplet_ids ?? [],
})

export const createVolume = async (
  token: string,
  opts: { name: string; region: string; sizeGb: number },
): Promise<Volume> => {
  const body: any = await request(token, "/volumes", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      region: opts.region,
      size_gigabytes: opts.sizeGb,
      // Formatted on creation so the box only has to mount it. Formatting on
      // first boot would mean a cloud-init that can destroy a workspace by
      // running twice.
      filesystem_type: "ext4",
    }),
  })
  return volume(body.volume)
}

export const getVolume = async (token: string, id: string): Promise<Volume | null> => {
  try {
    const body: any = await request(token, `/volumes/${id}`)
    return body?.volume ? volume(body.volume) : null
  } catch {
    return null
  }
}

/**
 * Attaches, and waits for the action to finish.
 *
 * The droplet cannot mount a device that is not there yet, and the API returns
 * before the attach completes — so a cloud-init that runs immediately finds
 * nothing at /dev/disk/by-id and mounts an empty directory instead, which looks
 * exactly like an empty workspace.
 */
export const attachVolume = async (token: string, volumeId: string, dropletId: number): Promise<void> => {
  const body: any = await request(token, `/volumes/${volumeId}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "attach", droplet_id: dropletId }),
  })
  await settle(token, volumeId, body?.action?.id)
}

/**
 * Detaches, and waits.
 *
 * Called before a droplet is destroyed. A volume left attached to a droplet
 * that no longer exists is not automatically freed, and it goes on being
 * charged for while belonging to nothing.
 */
export const detachVolume = async (token: string, volumeId: string, dropletId: number): Promise<void> => {
  const body: any = await request(token, `/volumes/${volumeId}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "detach", droplet_id: dropletId }),
  })
  await settle(token, volumeId, body?.action?.id)
}

export const destroyVolume = async (token: string, volumeId: string): Promise<void> => {
  await request(token, `/volumes/${volumeId}`, { method: "DELETE" })
}

/** Polls one volume action to completion. Gives up rather than hanging. */
const settle = async (token: string, volumeId: string, actionId?: number, tries = 30): Promise<void> => {
  if (!actionId) return
  for (let i = 0; i < tries; i++) {
    const body: any = await request(token, `/volumes/${volumeId}/actions/${actionId}`)
    const status = body?.action?.status
    if (status === "completed") return
    if (status === "errored") throw new Error("DigitalOcean could not move that volume.")
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error("DigitalOcean is taking too long with that volume.")
}
