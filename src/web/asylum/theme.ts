/**
 * Light, dark, or whatever the machine says.
 *
 * Same shape as Stohr's — `data-theme` on the document element, a localStorage
 * key, and "system" meaning *absent* rather than a third stored value. Storing
 * "system" as a string works right up until someone changes their OS theme
 * while the tab is open, at which point the stored value is stale and the page
 * disagrees with every other window on the machine.
 *
 * The terminal is exempt. A terminal is dark the way a code editor is dark, and
 * a light one is a novelty nobody asked for — `--az-term-*` stays fixed across
 * both themes in `style.css`.
 */

export type Theme = "light" | "dark" | "system"

const KEY = "devpipe_theme"

export const getTheme = (): Theme => {
  const stored = localStorage.getItem(KEY)
  return stored === "light" || stored === "dark" ? stored : "system"
}

export const applyTheme = (theme: Theme) => {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light")
}

export const setTheme = (theme: Theme) => {
  if (theme === "system") localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, theme)
  applyTheme(theme)
}

/**
 * Follow the system while it is being followed.
 *
 * Registered once at module load rather than in a hook: this is a property of
 * the document, not of any component, and a listener that mounts and unmounts
 * with a view stops working the moment somebody navigates away from it.
 */
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getTheme() === "system") applyTheme("system")
})
