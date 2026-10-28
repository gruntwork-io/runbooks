import "@testing-library/jest-dom/vitest"
import { expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Equal, Redacted } from "effect"

// A Redacted (a sensitive block output) keeps its value outside the object, so
// structural equality would call any two of them equal, whatever they hold.
// Compare them by value, and never equal to a plain string.
expect.addEqualityTesters([
  function redactedEquals(a: unknown, b: unknown) {
    const aRedacted = Redacted.isRedacted(a)
    const bRedacted = Redacted.isRedacted(b)
    if (!aRedacted && !bRedacted) return undefined
    return aRedacted && bRedacted && Equal.equals(a, b)
  },
])

// jsdom doesn't implement matchMedia. Stub it so providers/components that read
// prefers-color-scheme (e.g. ThemeProvider) work in tests. Individual tests can
// still override window.matchMedia for finer-grained control.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

// jsdom implements neither ResizeObserver nor scrollIntoView. cmdk (the command
// palette behind the region pickers) calls both on mount, so give it no-ops.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// A block folded by autoCollapse hides its parts with a stylesheet, which
// jsdom applies once it's on the page, so toBeVisible sees what the app shows.
// Vitest blanks imported CSS, even with ?raw, so it's read from disk.
const autoCollapseStyle = document.createElement("style")
autoCollapseStyle.textContent = readFileSync(
  resolve(__dirname, "../components/mdx/_shared/components/AutoCollapse.css"),
  "utf8",
)
document.head.appendChild(autoCollapseStyle)
