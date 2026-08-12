import { describe, expect, test } from "bun:test"
import { CATALOG } from "../src/boxes/catalog.ts"
import { cloudInit } from "../src/boxes/cloudinit.ts"
import { bakedIds, bakeScript, imageName } from "../src/boxes/image.ts"

/**
 * The box image, and what a box does when it boots from one.
 *
 * Most of what is worth asserting here is about what the image must *not*
 * carry. An image is copied to every box built from it, so anything identifying
 * baked into one is identity every future box shares.
 */

const base = {
  hostname: "b.example.com",
  agentToken: "tok",
  daemonUrl: "https://example.com/devpiped",
  callbackUrl: "https://example.com/cb",
  logUrl: "https://example.com/cb/log",
  loginsUrl: "https://example.com/cb/logins",
  callbackSecret: "secret",
}

describe("what goes into the image", () => {
  test("every installable tool, in dependency order", () => {
    const ids = bakedIds()
    expect(ids.length).toBe(CATALOG.length)
    // node before the things that are installed with npm, or the bake fails
    // exactly the way a box would.
    const needsNode = CATALOG.find(t => (t.requires ?? []).includes("node"))
    if (needsNode) expect(ids.indexOf("node")).toBeLessThan(ids.indexOf(needsNode.id))
  })

  test("a tool that will not install fails the bake", () => {
    // Baking a broken tool is worse than a slow box: every box built from the
    // image is missing it, and nothing says so until somebody runs it.
    expect(bakeScript()).toContain("bake.failed")
    expect(bakeScript()).toMatch(/if \[ -s \/var\/log\/bake\.failed \]/)
    expect(bakeScript()).toContain("exit 1")
  })

  test("installs that belong to the user run as the user", () => {
    const script = bakeScript()
    const asUser = CATALOG.filter(t => t.runAs === "devpipe")
    expect(asUser.length).toBeGreaterThan(0)
    // Otherwise the installer writes into root's home and the tool is missing
    // from the PATH of the only account that ever logs in.
    expect(script).toContain("runuser -l devpipe -c")
    expect(script).toContain("useradd --create-home --shell /bin/bash devpipe")
  })

  // The whole point of the image is that these are per-box, not per-image.
  test("carries no machine identity", () => {
    const script = bakeScript()
    expect(script).toContain("rm -f /etc/ssh/ssh_host_*")
    expect(script).toContain("truncate -s 0 /etc/machine-id")
    expect(script).toContain("cloud-init clean")
  })

  test("carries nobody's credentials", () => {
    // Agent logins are fetched per box over the encrypted login path. An image
    // is copied wholesale, so anything secret in it belongs to everyone.
    const script = bakeScript()
    for (const secret of [".credentials.json", "agentToken", "loginsUrl", "sync.json"]) {
      expect(script).not.toContain(secret)
    }
  })

  test("named by date, so a rebuild does not shadow the old one", () => {
    expect(imageName("20260812")).toBe("devpipe-box-20260812")
    expect(imageName("20260813")).not.toBe(imageName("20260812"))
  })
})

describe("booting from a prebaked image", () => {
  test("skips what is already there", () => {
    const slow = cloudInit({ ...base, tools: ["claude-code", "git"] })
    const fast = cloudInit({ ...base, tools: ["claude-code", "git"], preinstalled: ["claude-code", "git", "node"] })
    expect(slow).toContain("Installing Claude Code")
    expect(fast).not.toContain("Installing Claude Code")
    // and is meaningfully shorter, which is the entire point
    expect(fast.length).toBeLessThan(slow.length)
  })

  test("still installs a tool the image predates", () => {
    // An image baked before a tool existed genuinely does not have it. Skipping
    // it because the catalog says so produces a box missing the tool it was
    // asked for.
    const script = cloudInit({ ...base, tools: ["claude-code", "git"], preinstalled: ["git"] })
    expect(script).toContain("Installing Claude Code")
    expect(script).not.toContain("Installing Git")
  })

  test("does everything that is per-box regardless", () => {
    const script = cloudInit({
      ...base,
      tools: ["claude-code"],
      preinstalled: bakedIds(),
      volumeName: "dp-1-main",
    })
    // None of this is bakeable: it is this box's name, this box's daemon token,
    // this person's logins, and this workspace.
    for (const phase of ["user", "daemon", "logins", "dns", "tls", "workspace"]) {
      expect(script).toContain(`phase "${phase}"`)
    }
  })
})
