import { describe, expect, test } from "bun:test"
import { commandOf, isShell, loginShell, SHELLS, shellPath } from "../src/util/shell.ts"

/**
 * How a tool is launched on a box.
 *
 * The bug this file exists for was not subtle in effect — every agent CLI
 * failed to start — but it was invisible in the code: `argv: ["claude"]` looks
 * exactly like what you want, and the daemon's PATH is somewhere else entirely.
 */

describe("launching a tool", () => {
  test("goes through a login shell so installers' bin directories are found", () => {
    // Tools install into ~/.local/bin, ~/.bun/bin, ~/.cargo/bin. A systemd
    // service has none of those on PATH, so exec'ing the bare name gives
    // ENOENT for a binary that is sitting right there.
    expect(loginShell(["claude"])).toEqual(["/bin/bash", "-l", "-c", "exec 'claude'"])
  })

  test("execs, so signals reach the tool and not a wrapper", () => {
    expect(loginShell(["claude"])[3]).toStartWith("exec ")
  })

  test("passes -l and -c separately", () => {
    // bash and zsh accept `-lc`; fish does not. A box set to fish would fail
    // on every launch, and nothing in the error would say why.
    const argv = loginShell(["claude"], "fish")
    expect(argv[1]).toBe("-l")
    expect(argv[2]).toBe("-c")
  })

  test("uses the box's own shell", () => {
    expect(loginShell(["claude"], "zsh")[0]).toBe("/usr/bin/zsh")
    expect(loginShell(["claude"], "fish")[0]).toBe("/usr/bin/fish")
  })

  test("an unknown shell falls back rather than failing", () => {
    // A box row written before boxes had a shell has none, and it must still
    // open a terminal.
    expect(loginShell(["claude"], "")[0]).toBe("/bin/bash")
    expect(shellPath("nonsense")).toBe("/bin/bash")
  })

  test("asking for a plain shell stays a plain shell", () => {
    // Empty argv means "give me my shell", and the daemon already spawns the
    // account's login shell for that. Wrapping it would nest one in another.
    expect(loginShell([])).toEqual([])
  })

  test("arguments survive quoting", () => {
    expect(loginShell(["claude", "--resume", "a b"])[3]).toBe("exec 'claude' '--resume' 'a b'")
    expect(loginShell(["it's"])[3]).toBe(`exec 'it'\\''s'`)
  })
})

describe("reading a session back", () => {
  test("a wrapped session is named for the tool, not the shell", () => {
    // Otherwise every session in the sidebar reads "bash" until the program
    // gets round to setting a terminal title.
    expect(commandOf(loginShell(["claude"]))).toBe("claude")
    expect(commandOf(loginShell(["codex"], "zsh"))).toBe("codex")
  })

  test("a quoted argument comes back intact", () => {
    expect(commandOf(loginShell(["it's"]))).toBe("it's")
  })

  test("an unwrapped session still gets a name", () => {
    // Sessions created before this shipped, and plain shells.
    expect(commandOf(["/bin/bash"])).toBe("bash")
    expect(commandOf([])).toBe("")
  })
})

describe("the shells on offer", () => {
  test("bash needs no package and the others do", () => {
    // Choosing a shell has to install it, or chsh points the account at a
    // binary that is not there and every session on the box fails.
    expect(SHELLS.bash.tool).toBeNull()
    expect(SHELLS.zsh.tool).toBe("zsh")
    expect(SHELLS.fish.tool).toBe("fish")
  })

  test("only known shells are accepted", () => {
    expect(isShell("zsh")).toBe(true)
    expect(isShell("/bin/sh; rm -rf /")).toBe(false)
  })
})
