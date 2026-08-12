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

const stub = (firewalls: any[]) => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const path = url.replace("https://api.digitalocean.com/v2", "")
    calls.push({
      method: init.method ?? "GET",
      path,
      body: init.body ? JSON.parse(init.body) : null,
    })
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
