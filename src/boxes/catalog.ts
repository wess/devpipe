/**
 * What the setup wizard offers.
 *
 * Deliberately a short, curated list rather than a package search. A free-form
 * picker invites broken boxes and support load, and everything not here is
 * still one `apt install` away in a shell the user already has. The value of
 * the wizard is not the checkboxes — it is that the choices are recorded, so a
 * box can be rebuilt identically and "destroy and recreate" stops being scary.
 */

export type Tool = {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly group: "agent" | "runtime" | "tooling" | "service" | "shell"
  /** Rough resident cost, so the wizard can warn before a box thrashes. */
  readonly memoryMb: number
  /** Shell that installs it on Debian, non-interactive. */
  readonly install: string
  /**
   * Who installs it. Anything that keeps state in a home directory has to be
   * installed as the user who will run it — an agent CLI installed as root
   * lands in `/root/.local/bin`, is not on the terminal user's PATH, and puts
   * the credentials from `/login` somewhere they can never read.
   */
  readonly runAs?: "root" | "devpipe"
  readonly defaultOn?: boolean
  /** Tools that must also be selected; the wizard resolves these. */
  readonly requires?: readonly string[]
}

export const CATALOG: readonly Tool[] = [
  // ---- agents: the reason the product exists ------------------------------
  {
    id: "claude-code",
    runAs: "devpipe",
    name: "Claude Code",
    summary: "Anthropic's agent CLI. Sign in with your own subscription.",
    group: "agent",
    memoryMb: 400,
    defaultOn: true,
    install: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  {
    id: "codex",
    runAs: "devpipe",
    name: "Codex CLI",
    summary: "OpenAI's agent CLI.",
    group: "agent",
    memoryMb: 350,
    requires: ["node"],
    install: "npm install -g @openai/codex",
  },
  {
    id: "gemini",
    runAs: "devpipe",
    name: "Gemini CLI",
    summary: "Google's agent CLI.",
    group: "agent",
    memoryMb: 350,
    requires: ["node"],
    install: "npm install -g @google/gemini-cli",
  },

  // ---- runtimes ----------------------------------------------------------
  {
    id: "node",
    name: "Node.js",
    summary: "Node 22 and npm.",
    group: "runtime",
    memoryMb: 80,
    install: "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
  },
  {
    id: "bun",
    runAs: "devpipe",
    name: "Bun",
    summary: "Bun runtime and package manager.",
    group: "runtime",
    memoryMb: 60,
    install: "curl -fsSL https://bun.sh/install | bash",
  },
  {
    id: "python",
    name: "Python",
    summary: "Python 3 with pip and venv.",
    group: "runtime",
    memoryMb: 60,
    install: "apt-get install -y python3 python3-pip python3-venv",
  },
  {
    id: "rust",
    runAs: "devpipe",
    name: "Rust",
    summary: "rustup with the stable toolchain.",
    group: "runtime",
    memoryMb: 40,
    install: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
  },
  {
    id: "go",
    name: "Go",
    summary: "The Go toolchain.",
    group: "runtime",
    memoryMb: 40,
    install: "apt-get install -y golang-go",
  },

  // ---- tooling -----------------------------------------------------------
  {
    id: "git",
    name: "Git",
    summary: "Version control. Almost everything assumes it.",
    group: "tooling",
    memoryMb: 5,
    defaultOn: true,
    install: "apt-get install -y git",
  },
  {
    id: "ripgrep",
    name: "ripgrep + fd",
    summary: "Fast search. Agents lean on these heavily.",
    group: "tooling",
    memoryMb: 5,
    defaultOn: true,
    install: "apt-get install -y ripgrep fd-find",
  },
  {
    id: "neovim",
    name: "Neovim",
    summary: "For when you want to edit something yourself.",
    group: "tooling",
    memoryMb: 30,
    install: "apt-get install -y neovim",
  },
  {
    id: "gh",
    name: "GitHub CLI",
    summary: "Pull requests and issues from the terminal.",
    group: "tooling",
    memoryMb: 20,
    install:
      "apt-get install -y gh || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg " +
      "-o /usr/share/keyrings/githubcli.gpg && echo 'deb [signed-by=/usr/share/keyrings/githubcli.gpg] " +
      "https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list && " +
      "apt-get update && apt-get install -y gh)",
  },
  {
    id: "zsh",
    name: "Zsh",
    summary: "Interactive shell. Picking it here makes it your login shell.",
    group: "shell",
    memoryMb: 10,
    install: "apt-get install -y zsh",
  },
  {
    id: "fish",
    name: "Fish",
    summary: "Interactive shell with completions out of the box.",
    group: "shell",
    memoryMb: 12,
    install: "apt-get install -y fish",
  },
  {
    id: "docker",
    name: "Docker",
    summary: "Containers. Hungry — give the box 2GB or more.",
    group: "service",
    memoryMb: 300,
    install: "curl -fsSL https://get.docker.com | sh",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    summary: "A local database for whatever you are building.",
    group: "service",
    memoryMb: 200,
    install: "apt-get install -y postgresql && systemctl enable --now postgresql",
  },
  {
    id: "redis",
    name: "Redis",
    summary: "A local key-value store.",
    group: "service",
    memoryMb: 60,
    install: "apt-get install -y redis-server && systemctl enable --now redis-server",
  },
]

export const byId = (id: string): Tool | undefined => CATALOG.find(t => t.id === id)

export const defaults = (): string[] => CATALOG.filter(t => t.defaultOn).map(t => t.id)

/**
 * Expands a selection to include what it depends on, in an order that installs
 * cleanly — a runtime before the agent that needs it.
 */
export const resolve = (ids: readonly string[]): Tool[] => {
  const wanted = new Set<string>()
  const add = (id: string) => {
    const tool = byId(id)
    if (!tool || wanted.has(id)) return
    for (const dep of tool.requires ?? []) add(dep)
    wanted.add(id)
  }
  for (const id of ids) add(id)

  // Shells first: cloud-init chsh's to the chosen one after the installs, and
  // an agent that writes shell config wants the shell it is writing for to
  // already exist.
  const rank = { shell: 0, runtime: 1, tooling: 2, service: 3, agent: 4 } as const
  return CATALOG.filter(t => wanted.has(t.id)).sort((a, b) => rank[a.group] - rank[b.group])
}

/** What the selection will cost in memory, before the OS's own ~120MB. */
export const memoryFor = (ids: readonly string[]): number => resolve(ids).reduce((sum, t) => sum + t.memoryMb, 0)

/** Droplet sizes offered, smallest first. */
export const SIZES = [
  { slug: "s-1vcpu-512mb-10gb", label: "512 MB", memoryMb: 512, monthly: 4 },
  { slug: "s-1vcpu-1gb", label: "1 GB", memoryMb: 1024, monthly: 6 },
  { slug: "s-1vcpu-2gb", label: "2 GB", memoryMb: 2048, monthly: 12 },
  { slug: "s-2vcpu-4gb", label: "4 GB", memoryMb: 4096, monthly: 24 },
] as const

export const REGIONS = [
  { slug: "nyc3", label: "New York" },
  { slug: "sfo3", label: "San Francisco" },
  { slug: "tor1", label: "Toronto" },
  { slug: "lon1", label: "London" },
  { slug: "fra1", label: "Frankfurt" },
  { slug: "ams3", label: "Amsterdam" },
  { slug: "sgp1", label: "Singapore" },
  { slug: "syd1", label: "Sydney" },
  { slug: "blr1", label: "Bangalore" },
] as const

/**
 * Whether a selection fits a size, with the OS's own footprint accounted for.
 * The failure this prevents is the OOM killer ending an agent mid-task, which
 * surfaces to the user as a random disconnect rather than as running out of
 * memory — miserable to diagnose from a bug report.
 */
export const fits = (ids: readonly string[], sizeSlug: string) => {
  const size = SIZES.find(s => s.slug === sizeSlug)
  if (!size) return { ok: false, needed: 0, available: 0 }
  const OS_OVERHEAD = 140
  const needed = memoryFor(ids) + OS_OVERHEAD
  return { ok: needed <= size.memoryMb, needed, available: size.memoryMb }
}
