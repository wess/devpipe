/**
 * How a tool is started on a box, and how to read that back.
 *
 * The two halves live together because they are one format. The control plane
 * wraps a command so the box's login shell resolves it; the sidebar unwraps it
 * so a session started as `claude` does not appear in the list as `bash`.
 */

/** Single quotes, for a string going into a shell command. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The shells a box can be set to.
 *
 * Bash is not in the table because it is not a choice — it is on the image, it
 * is what a box falls back to, and it is what `chsh` is undone to. The others
 * have to be installed, which is why picking one adds a tool to the build.
 */
export const SHELLS = {
  bash: { path: "/bin/bash", label: "Bash", tool: null },
  zsh: { path: "/usr/bin/zsh", label: "Zsh", tool: "zsh" },
  fish: { path: "/usr/bin/fish", label: "Fish", tool: "fish" },
} as const

export type ShellName = keyof typeof SHELLS

export const isShell = (s: string): s is ShellName => s in SHELLS

/** Falls back rather than throwing: a box row written before this existed. */
export const shellPath = (name: string): string => (isShell(name) ? SHELLS[name].path : SHELLS.bash.path)

/**
 * Wraps a command so it runs under a login shell.
 *
 * `/etc/profile.d/*` is then sourced and the tool is found wherever its
 * installer put it — `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`. Handing the
 * daemon a bare `claude` makes it exec that name against a *systemd service's*
 * PATH, which contains none of those, and the failure is `No such file or
 * directory` for a binary sitting right there.
 *
 * Deliberately done here rather than by giving the daemon a PATH. That fixes
 * boxes built after the change and leaves every existing one broken, reachable
 * only by SSH — which is not something a customer can be asked to do. This runs
 * on the control plane, so it repairs every box that already exists the moment
 * it ships.
 *
 * `exec` so the shell replaces itself with the tool. Without it the pty's child
 * is bash, and a signal meant for the agent goes to the wrapper instead.
 *
 * An empty argv is left empty: that is "give me a shell", and the daemon's own
 * default already is one.
 *
 * The quoting is for correctness, not containment. Anything reaching here is
 * authenticated as the box's owner and the box exists to run their shell.
 */
export const loginShell = (argv: readonly string[], shell = "bash"): string[] =>
  // `-l -c` as two arguments rather than `-lc`: bash and zsh accept the
  // bundled form, fish does not, and a box set to fish would fail on every
  // launch for a reason nothing would name.
  argv.length === 0 ? [] : [shellPath(shell), "-l", "-c", `exec ${argv.map(quote).join(" ")}`]

/**
 * The command a session is actually running.
 *
 * The daemon reports the argv it was given, so every wrapped session would
 * otherwise read as "bash" in the sidebar until the program got round to
 * setting a terminal title.
 */
export const commandOf = (argv: readonly string[]): string => {
  const wrapped = argv.length === 4 && argv[1] === "-l" && argv[2] === "-c" ? argv[3] : null
  if (wrapped?.startsWith("exec ")) {
    const first = wrapped.slice(5).match(/^'((?:[^']|'\\'')*)'/)
    if (first) return first[1].replace(/'\\''/g, "'")
  }
  return argv[0]?.split("/").pop() ?? ""
}
