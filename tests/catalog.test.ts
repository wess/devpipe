import { describe, expect, test } from "bun:test"
import { CATALOG, byId, defaults, fits, memoryFor, resolve } from "../src/boxes/catalog.ts"
import { db, truncateAll } from "./setup.ts"

describe("catalog", () => {
  test("every tool a catalog entry requires actually exists", () => {
    for (const tool of CATALOG) {
      for (const dep of tool.requires ?? []) {
        expect(byId(dep), `${tool.id} requires missing tool ${dep}`).toBeDefined()
      }
    }
  })

  test("dependencies are pulled in and installed before what needs them", () => {
    // Codex needs node; picking codex alone must still produce a working box.
    const order = resolve(["codex"]).map(t => t.id)
    expect(order).toContain("node")
    expect(order.indexOf("node")).toBeLessThan(order.indexOf("codex"))
  })

  test("a selection is not installed twice", () => {
    const ids = resolve(["codex", "gemini", "node"]).map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the defaults are a usable box", () => {
    const ids = defaults()
    expect(ids).toContain("claude-code")
    expect(ids).toContain("git")
    expect(fits(ids, "s-1vcpu-1gb").ok).toBe(true)
  })

  test("memory is counted so the wizard can warn before a box thrashes", () => {
    // Docker and Postgres on the smallest box is exactly the combination that
    // would get killed under load rather than fail honestly at setup.
    const heavy = ["claude-code", "docker", "postgres"]
    expect(fits(heavy, "s-1vcpu-512mb-10gb").ok).toBe(false)
    expect(fits(heavy, "s-2vcpu-4gb").ok).toBe(true)
    expect(memoryFor(["git"])).toBeLessThan(memoryFor(["git", "docker"]))
  })

  test("an unknown size never reports as fitting", () => {
    expect(fits(["git"], "not-a-size").ok).toBe(false)
  })

  test("unknown tool ids are ignored rather than crashing the wizard", () => {
    expect(resolve(["git", "nonsense"]).map(t => t.id)).toEqual(["git"])
  })
})

describe("who installs what", () => {
  test("agent CLIs install as the user who will run them", () => {
    // Installed as root they land in /root/.local/bin — off the terminal
    // user's PATH — and /login writes credentials the user cannot read.
    for (const id of ["claude-code", "codex", "gemini"]) {
      expect(byId(id)?.runAs, `${id} must install as devpipe`).toBe("devpipe")
    }
  })

  test("system packages still install as root", () => {
    for (const id of ["git", "python", "docker", "postgres"]) {
      expect(byId(id)?.runAs ?? "root").toBe("root")
    }
  })
})
