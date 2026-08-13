import { beforeEach, describe, expect, test } from "bun:test"
import { cloudInit } from "../src/boxes/cloudinit.ts"
import { boxFirewallSpec, BOX_FIREWALL_NAME, ensureBoxFirewall } from "../src/boxes/digitalocean.ts"

/**
 * The firewall a box is created behind.
 *
 * A box is a public droplet whose user has passwordless sudo and an agent that
 * runs what it likes. What is reachable on it is not something to establish by
 * reading the code once.
 */

const realFetch = globalThis.fetch
const calls: { method: string; path: string; body: any }[] = []

/** The control plane: tagged `devpipe`, and deliberately not `devpipe-box`. */
const CONTROL_PLANE = [{ id: 1, tags: ["devpipe"], networks: { v4: [{ type: "public", ip_address: "203.0.113.9" }] } }]

const stub = (firewalls: any[], droplets: any[] | null = CONTROL_PLANE) => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const path = url.replace("https://api.digitalocean.com/v2", "")
    calls.push({
      method: init.method ?? "GET",
      path,
      body: init.body ? JSON.parse(init.body) : null,
    })
    if (path.startsWith("/droplets?")) {
      if (droplets === null) return new Response("nope", { status: 500 })
      return new Response(JSON.stringify({ droplets }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (path.startsWith("/firewalls?")) {
      return new Response(JSON.stringify({ firewalls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ firewall: { id: "fw-new" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  }) as any
}

/** The sources on the rule that opens a port, from a create or update body. */
const sourcesFor = (body: any, ports: string): string[] =>
  body.inbound_rules.find((r: any) => r.ports === ports)?.sources?.addresses ?? []

beforeEach(() => {
  calls.length = 0
  globalThis.fetch = realFetch
})

describe("what a box exposes to the internet", () => {
  const spec = boxFirewallSpec("devpipe-box")
  const inbound = spec.inbound_rules.map(r => r.ports)

  test("only ssh, the acme challenge, and https", () => {
    expect(inbound.sort()).toEqual(["22", "443", "80"])
  })

  test("the daemon's own port is not reachable", () => {
    // devpiped binds 127.0.0.1:7788 and is only ever reached through Caddy.
    // Opening it here would make DEVPIPE_INSECURE=1 — plain HTTP, correct
    // over loopback — a plaintext service on the public internet.
    expect(inbound).not.toContain("7788")
  })

  test("nothing a user or an agent starts is reachable by accident", () => {
    // The failure this exists for: `docker run -p 5432:5432`, a dev server on
    // 0.0.0.0:3000, `python -m http.server`. None of them are decisions to
    // publish a service, and all of them did before this.
    for (const port of ["3000", "5432", "6379", "8080", "all"]) {
      expect(inbound).not.toContain(port)
    }
  })

  test("a box can still reach out", () => {
    // Egress stays open — the box exists to fetch packages, clone repositories
    // and call APIs. UDP included, because blocking it silently breaks DNS and
    // the whole box then looks like a network outage.
    const protocols = new Set(spec.outbound_rules.map(r => r.protocol))
    expect([...protocols].sort()).toEqual(["icmp", "tcp", "udp"])
  })

  test("but it cannot send mail", () => {
    // The one egress worth closing. A box that relays spam gets the complaint
    // sent to the provider account every customer's box is created under, and
    // the provider's remedy is to lock that account — so one bad customer
    // costs everyone their machine. Nothing here needs SMTP from a box.
    const reachable = (port: number) =>
      spec.outbound_rules.some(rule => {
        if (rule.protocol !== "tcp") return false
        const ports = String(rule.ports)
        if (ports === "all") return true
        const [from, to] = ports.split("-").map(Number)
        return port >= from && port <= (to ?? from)
      })

    for (const blocked of [25, 465, 587]) {
      expect(reachable(blocked), `port ${blocked} is reachable`).toBe(false)
    }
    // Everything either side of them still is, or the box cannot work.
    for (const open of [22, 24, 26, 443, 464, 466, 586, 588, 8080, 65535]) {
      expect(reachable(open), `port ${open} was closed by accident`).toBe(true)
    }
  })

  test("ssh answers the addresses it is given and nobody else", () => {
    // Nobody on the internet has a key: the authorised keys are the ones in
    // `boxes_ssh_key_ids`, an instance-wide setting, so port 22 open to
    // everyone was a port every scanner could knock on and one person could
    // use. It is also `ssh -D`, which is the zero-effort way to make a box a
    // SOCKS proxy — no install, no root, works from any laptop.
    const restricted = boxFirewallSpec("devpipe-box", ["203.0.113.9/32"])
    expect(sourcesFor(restricted, "22")).toEqual(["203.0.113.9/32"])
    // Not the other two. Let's Encrypt validates from addresses nobody can
    // enumerate, and 443 is the product.
    for (const port of ["80", "443"]) {
      expect(sourcesFor(restricted, port)).toEqual(["0.0.0.0/0", "::/0"])
    }
  })

  test("it is attached by tag, so it covers boxes nobody remembered", () => {
    expect(spec.tags).toEqual(["devpipe-box"])
  })

  test("and not the machine that provisions them", () => {
    // The control plane carries the `devpipe` tag as well. A firewall hung on
    // that reaches the host running the API — which is how closing outbound
    // mail on boxes silently stopped the control plane sending a password
    // reset, on the one host a mail server was about to be installed on.
    expect(spec.tags).not.toContain("devpipe")
  })
})

describe("keeping the firewall the way it should be", () => {
  test("creates it when the account has none", async () => {
    stub([])
    const id = await ensureBoxFirewall("token")
    expect(id).toBe("fw-new")
    const post = calls.find(c => c.method === "POST")
    expect(post?.path).toBe("/firewalls")
    expect(post?.body.name).toBe(BOX_FIREWALL_NAME)
    globalThis.fetch = realFetch
  })

  test("puts an edited one back rather than leaving it", async () => {
    // A rule opened by hand during an afternoon's debugging and never removed
    // is the realistic way this protection disappears — not somebody deleting
    // the firewall, which is loud.
    stub([{ id: "fw-1", name: BOX_FIREWALL_NAME, inbound_rules: [{ protocol: "tcp", ports: "5432" }] }])
    const id = await ensureBoxFirewall("token")
    expect(id).toBe("fw-1")
    const put = calls.find(c => c.method === "PUT")
    expect(put?.path).toBe("/firewalls/fw-1")
    expect(put?.body.inbound_rules.map((r: any) => r.ports).sort()).toEqual(["22", "443", "80"])
    globalThis.fetch = realFetch
  })

  test("leaves a firewall that is not ours alone", async () => {
    stub([{ id: "fw-other", name: "someone-elses", inbound_rules: [] }])
    await ensureBoxFirewall("token")
    expect(calls.find(c => c.path === "/firewalls/fw-other")).toBeUndefined()
    globalThis.fetch = realFetch
  })
})

describe("who may reach port 22", () => {
  test("the control plane, without anybody configuring it", async () => {
    // Derived rather than written down, because a hardcoded address is right
    // until the host is rebuilt and then wrong silently: the firewall would go
    // on converging, and it would be found out the next time a box wedged.
    stub([])
    await ensureBoxFirewall("token")
    expect(sourcesFor(calls.find(c => c.method === "POST")!.body, "22")).toEqual(["203.0.113.9/32"])
    globalThis.fetch = realFetch
  })

  test("and the operator's own address, when they add one", async () => {
    // Both, not one or the other. Listing a home address should not quietly
    // shut the door on the host that is always reachable.
    stub([])
    await ensureBoxFirewall("token", "devpipe-box", ["198.51.100.4/32"])
    expect(sourcesFor(calls.find(c => c.method === "POST")!.body, "22").sort()).toEqual([
      "198.51.100.4/32",
      "203.0.113.9/32",
    ])
    globalThis.fetch = realFetch
  })

  test("never a box, whatever else is on the account", async () => {
    // A box is `devpipe-box` as well as `devpipe`. Letting one box SSH another
    // is the whole fleet reachable from any single compromised machine.
    stub([], [
      ...CONTROL_PLANE,
      { id: 2, tags: ["devpipe", "devpipe-box"], networks: { v4: [{ type: "public", ip_address: "198.51.100.77" }] } },
    ])
    await ensureBoxFirewall("token")
    expect(sourcesFor(calls.find(c => c.method === "POST")!.body, "22")).toEqual(["203.0.113.9/32"])
    globalThis.fetch = realFetch
  })

  test("everyone, rather than nobody, when the address cannot be resolved", async () => {
    // An empty source list is not a stricter firewall, it is a locked room with
    // the key inside: no way onto a box that wedged during setup and no way to
    // fix it but the provider console. Falling back to today's behaviour is
    // worse than the restriction and far better than locking ourselves out of
    // every box at once.
    stub([], null)
    await ensureBoxFirewall("token")
    expect(sourcesFor(calls.find(c => c.method === "POST")!.body, "22")).toEqual(["0.0.0.0/0", "::/0"])
    globalThis.fetch = realFetch
  })
})

describe("what a box is built with", () => {
  const script = cloudInit({
    hostname: "b.example.com",
    agentToken: "tok",
    tools: ["bun", "claude-code"],
    daemonUrl: "https://example.com/devpiped",
    callbackUrl: "https://example.com/cb",
    logUrl: "https://example.com/cb/log",
    loginsUrl: "https://example.com/cb/logins",
    callbackSecret: "secret",
  })

  test("the daemon can find tools installed into the user's home", () => {
    // The daemon execs a tool by name, and profile.d only reaches login
    // shells. Without this every tool was installed and unreachable from the
    // button that starts it, while typing the same name in a shell worked.
    const env = script.slice(script.indexOf("cat > /etc/devpipe/env"))
    expect(env).toMatch(/^PATH=.*\.local\/bin/m)
    for (const dir of [".local/bin", ".bun/bin", ".cargo/bin"]) {
      expect(env).toContain(`/home/devpipe/${dir}`)
    }
  })

  test("unzip is installed before anything needs it", () => {
    // bun's installer requires it and only says so after downloading:
    // "error: unzip is required to install bun". The image has no unzip, so
    // bun failed on every box while every other tool succeeded.
    const base = script.slice(0, script.indexOf("phase \"user\""))
    expect(base).toMatch(/apt-get install .*unzip/)
  })
})

describe("what a box will install", () => {
  const script = cloudInit({
    hostname: "b.example.com",
    agentToken: "tok",
    tools: ["claude-code"],
    daemonUrl: "https://example.com/devpiped",
    callbackUrl: "https://example.com/cb",
    logUrl: "https://example.com/cb/log",
    loginsUrl: "https://example.com/cb/logins",
    callbackSecret: "secret",
  })

  test("peer-to-peer clients are pinned out of the archive", () => {
    // Not a boundary — the account has passwordless sudo and can delete the
    // pin. It is friction aimed at the person who types `apt install
    // transmission-daemon` because it was the first thing they thought of, and
    // what it prevents is a DMCA notice landing on the provider account every
    // customer's box is created under, where the remedy is to lock all of it.
    const pin = script.slice(script.indexOf("devpipe-p2p"))
    expect(pin).toContain("Pin-Priority: -1")
    for (const client of ["transmission", "deluge", "rtorrent", "qbittorrent", "aria2"]) {
      expect(pin).toContain(client)
    }
  })

  test("and nothing a developer needs is caught by it", () => {
    // A pin pattern is a glob. `git*` or a bare `*` here would take the box
    // apart, and the failure would only show up as a build that cannot
    // install its own dependencies.
    const patterns = script.slice(script.indexOf("Package:"), script.indexOf("Pin: release"))
    for (const wanted of ["git", "curl", "build-essential", "python3", "nodejs", "ripgrep"]) {
      expect(patterns.includes(`${wanted} `) || patterns.includes(`${wanted}*`)).toBe(false)
    }
    expect(patterns).not.toContain("*\n")
  })
})

describe("carrying project memory to a box", () => {
  test("the option reaches cloud-init, and is off unless asked for", () => {
    const withMemory = cloudInit({
      hostname: "b.example.com",
      agentToken: "tok",
      tools: ["claude-code"],
      daemonUrl: "https://example.com/devpiped",
      callbackUrl: "https://example.com/cb",
      logUrl: "https://example.com/cb/log",
      loginsUrl: "https://example.com/cb/logins",
      callbackSecret: "secret",
      synapse: true,
    })
    const without = cloudInit({
      hostname: "b.example.com",
      agentToken: "tok",
      tools: ["claude-code"],
      daemonUrl: "https://example.com/devpiped",
      callbackUrl: "https://example.com/cb",
      logUrl: "https://example.com/cb/log",
      loginsUrl: "https://example.com/cb/logins",
      callbackSecret: "secret",
    })
    expect(withMemory).toContain("Bringing your project memory")
    // Off by default. Memory is the account's, and a box that quietly carried
    // it because someone forgot to say no is the wrong way round.
    expect(without).not.toContain("Bringing your project memory")
  })

  test("the configuration never travels in cloud-init", () => {
    // Provider user data is retained and served to anything on the box that can
    // reach the metadata service. The server, the token and the key its
    // envelopes are sealed with go down the encrypted login path instead.
    const script = cloudInit({
      hostname: "b.example.com",
      agentToken: "tok",
      tools: ["claude-code"],
      daemonUrl: "https://example.com/devpiped",
      callbackUrl: "https://example.com/cb",
      logUrl: "https://example.com/cb/log",
      loginsUrl: "https://example.com/cb/logins",
      callbackSecret: "secret",
      synapse: true,
    })
    expect(script).not.toMatch(/sync\.key|sync\.token/)
  })
})

describe("mounting a workspace", () => {
  const base = {
    hostname: "b.example.com",
    agentToken: "tok",
    tools: ["claude-code"],
    daemonUrl: "https://example.com/devpiped",
    callbackUrl: "https://example.com/cb",
    logUrl: "https://example.com/cb/log",
    loginsUrl: "https://example.com/cb/logins",
    callbackSecret: "secret",
  }

  test("only when a workspace was attached", () => {
    expect(cloudInit(base)).not.toContain("Mounting your workspace")
    expect(cloudInit({ ...base, volumeName: "dp-1-main" })).toContain("Mounting your workspace")
  })

  test("mounts by volume id, and puts it in fstab the same way", () => {
    const script = cloudInit({ ...base, volumeName: "dp-1-main" })
    expect(script).toContain("/dev/disk/by-id/scsi-0DO_Volume_dp-1-main")
    // nofail, so a box whose volume is missing still boots to a terminal
    // somebody can look at rather than dropping to emergency mode.
    expect(script).toMatch(/\/home\/devpipe\/work ext4 [^\n]*nofail/)
  })

  // The failure this catches is silent: mounting before the account exists
  // leaves /home/devpipe owned by root, because useradd will not adopt a home
  // directory it did not create. The box comes up, and the agent cannot write
  // to its own home or the workspace under it.
  test("happens after the account it belongs to exists", () => {
    const script = cloudInit({ ...base, volumeName: "dp-1-main" })
    expect(script.indexOf("useradd --create-home")).toBeLessThan(script.indexOf("mkdir -p /home/devpipe/work"))
    expect(script.indexOf("mkdir -p /home/devpipe/work")).toBeLessThan(
      script.indexOf("chown devpipe:devpipe /home/devpipe/work"),
    )
  })

  // A mkfs here is the one command in the script that destroys something
  // irreplaceable. The volume is created with a filesystem already on it.
  test("never formats anything", () => {
    const script = cloudInit({ ...base, volumeName: "dp-1-main" })
    // Comments stripped first — the script explains at length why it does not
    // format, and the word appearing in that explanation is not a mkfs.
    const commands = script
      .split("\n")
      .filter(line => !line.trimStart().startsWith("#"))
      .join("\n")
    expect(commands).not.toMatch(/\bmkfs\b/)
  })
})

describe("the box's vault credential reaches the box", () => {
  // The lesson from the workspace volume: a feature can be complete, tested and
  // completely inert because the one option that switches it on was never
  // passed to the script that acts on it. These assert the wiring, not the
  // behaviour.
  const base = {
    hostname: "b.example.com",
    agentToken: "tok",
    tools: ["bun"] as const,
    daemonUrl: "https://example.com/devpiped",
    callbackUrl: "https://example.com/cb",
    logUrl: "https://example.com/cb/log",
    loginsUrl: "https://example.com/cb/logins",
    callbackSecret: "secret",
  }

  test("writes the credential when one is supplied", () => {
    const script = cloudInit({
      ...base,
      vaultToken: "vault-token-not-real",
      vaultUrl: "https://example.com/api/box/vault",
    })
    expect(script).toContain("/etc/devpipe/vault.env")
    expect(script).toContain("DEVPIPE_VAULT_TOKEN=vault-token-not-real")
    expect(script).toContain("DEVPIPE_VAULT_URL=https://example.com/api/box/vault")
  })

  test("is readable by the box's user, not root-only", () => {
    // 0600 would be tidier and would also mean the agent — the only thing that
    // needs it — cannot read it, so the vault would be unusable from the box.
    const script = cloudInit({
      ...base,
      vaultToken: "t",
      vaultUrl: "https://example.com/api/box/vault",
    })
    expect(script).toContain("chown root:devpipe /etc/devpipe/vault.env")
    expect(script).toContain("chmod 0640 /etc/devpipe/vault.env")
  })

  test("is exported to every shell, not just bash", () => {
    // profile.d reaches bash and nothing else. A zsh or fish box had
    // DEVPIPE_VAULT_URL unset, so `devpipe value get` reported "this box has no
    // vault credential" while the credential sat readable on disk.
    const script = cloudInit({
      ...base,
      vaultToken: "t",
      vaultUrl: "https://example.com/api/box/vault",
    })
    expect(script).toContain("/etc/profile.d/devpipe-vault.sh")
    expect(script).toContain("/etc/zsh/zshenv")
    expect(script).toContain("/etc/fish/conf.d/devpipe-vault.fish")
    // Three shells, three places that read /etc/devpipe/vault.env.
    expect(script.split("/etc/devpipe/vault.env").length - 1).toBeGreaterThanOrEqual(4)
  })

  test("writes nothing at all when no credential is supplied", () => {
    // An older box, or any path that forgets to thread it through, must not end
    // up with an empty token file that looks configured and authenticates as
    // nothing.
    const script = cloudInit(base)
    expect(script).not.toContain("vault.env")
    expect(script).not.toContain("DEVPIPE_VAULT_TOKEN")
  })
})

describe("the devpipe CLI reaches the box", () => {
  const base = {
    hostname: "b.example.com",
    agentToken: "tok",
    tools: ["bun"] as const,
    daemonUrl: "https://example.com/devpiped",
    callbackUrl: "https://example.com/cb",
    logUrl: "https://example.com/cb/log",
    loginsUrl: "https://example.com/cb/logins",
    callbackSecret: "secret",
    vaultToken: "t",
    vaultUrl: "https://example.com/api/box/vault",
  }

  test("downloads the binary and makes it executable", () => {
    const script = cloudInit({ ...base, cliUrl: "https://example.com/dist/devpipe" })
    expect(script).toContain("https://example.com/dist/devpipe")
    expect(script).toContain("chmod 0755 /usr/local/bin/devpipe")
  })

  test("registers it as an MCP server for the box user", () => {
    // Without this an agent has the vault available and no way to discover it,
    // which is the same as not shipping it.
    const script = cloudInit({ ...base, cliUrl: "https://example.com/dist/devpipe" })
    expect(script).toContain("/home/devpipe/.config/claude/mcp.json")
    expect(script).toContain('"args": ["mcp"]')
    // The box user's config, not root's: the daemon runs as root and this is
    // not the daemon's tool.
    expect(script).toContain("sudo -u devpipe")
  })

  test("is skipped entirely when no CLI url is configured", () => {
    const script = cloudInit(base)
    expect(script).not.toContain("/usr/local/bin/devpipe\n")
    expect(script).not.toContain("mcp.json")
  })
})

describe("every offered shell can find the installed tools", () => {
  // Installers drop binaries in ~/.local/bin, ~/.bun/bin and ~/.cargo/bin. Each
  // shell reads a different file to pick those up, and missing one produces the
  // worst kind of failure: the tool is installed, runnable, and "not found".
  //
  // fish was handled with a comment explaining that it ignores profile.d. zsh
  // has exactly the same problem and was overlooked — Debian's /etc/zsh/zprofile
  // does not source /etc/profile — so a zsh box shipped with claude, bun and
  // cargo invisible over SSH.
  const script = cloudInit({
    hostname: "b.example.com",
    agentToken: "tok",
    tools: ["bun", "claude-code"],
    daemonUrl: "https://example.com/devpiped",
    callbackUrl: "https://example.com/cb",
    logUrl: "https://example.com/cb/log",
    loginsUrl: "https://example.com/cb/logins",
    callbackSecret: "secret",
  })

  test("bash reads it from profile.d", () => {
    expect(script).toContain("/etc/profile.d/devpipe-path.sh")
  })

  test("fish reads it from conf.d", () => {
    expect(script).toContain("/etc/fish/conf.d/devpipe-path.fish")
  })

  test("zsh reads it from zshenv", () => {
    // zshenv rather than zprofile, so a non-login 'ssh box command' sees them too.
    expect(script).toContain("/etc/zsh/zshenv")
  })

  test("all three carry the same directories", () => {
    for (const dir of [".local/bin", ".bun/bin", ".cargo/bin"]) {
      // Once per shell: bash, fish, zsh.
      const hits = script.split(dir).length - 1
      expect(hits).toBeGreaterThanOrEqual(3)
    }
  })
})
