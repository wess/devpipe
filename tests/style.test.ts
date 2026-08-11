import { describe, expect, test } from "bun:test"

/**
 * Two rules that are load bearing and look decorative.
 *
 * Neither is caught by anything else here: the app renders, the tests pass,
 * and a whole dialog is unreadable. This is the cheapest place to notice.
 */

const css = await Bun.file("src/web/style.css").text()

const block = (selector: string) => {
  const at = css.indexOf(selector)
  if (at === -1) return ""
  return css.slice(at, css.indexOf("}", at))
}

describe("a dark page has to say so", () => {
  test("the root declares its colour scheme", () => {
    // Without this the browser assumes light, and the system colour keywords
    // in its own stylesheet resolve against that assumption. `CanvasText` is
    // then black — on <dialog>, on scrollbars, on autofilled inputs, on select
    // popups. None of which any rule in this file mentions.
    expect(block(":root")).toContain("color-scheme: dark")
  })

  test("a modal sets its own text colour", () => {
    // A <dialog> carries the UA's `color`, so it breaks inheritance from body
    // instead of passing it through. Every descendant without a colour of its
    // own took the browser's, which was black on #11151D — about 1.3:1, which
    // is not a contrast problem so much as invisible text.
    expect(block(".modal{")).toMatch(/color:var\(--text\)/)
  })
})
