import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { WorkspaceFileChange } from "@/hooks/useGitFileChanges"
import { ChangedFilesView } from "../ChangedFilesView"

// Draw.io and Figma exports often carry dashes, symbols or CJK text, and the
// backend hands SVGs over as decoded UTF-8 strings.
const svg = (title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><title>${title}</title><rect width="1" height="1"/></svg>`

const svgChange = (overrides: Partial<WorkspaceFileChange>): WorkspaceFileChange => ({
  path: "logo.svg",
  changeType: "modified",
  additions: 1,
  deletions: 1,
  language: "xml",
  ...overrides,
})

/** The SVG text a data: URI decodes to. */
const decodeDataUri = (src: string | null) => {
  expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
  return decodeURIComponent(src!.slice(src!.indexOf(",") + 1))
}

describe("ChangedFilesView SVG preview", () => {
  it("renders before and after previews of an SVG with non-Latin-1 text", () => {
    const before = svg("old — logo ✓ 日本")
    const after = svg("new — logo ✓ 日本")

    render(<ChangedFilesView changes={[svgChange({ originalContent: before, newContent: after })]} />)

    expect(decodeDataUri(screen.getByAltText("Before").getAttribute("src"))).toBe(before)
    expect(decodeDataUri(screen.getByAltText("After").getAttribute("src"))).toBe(after)
  })

  it("encodes Latin-1 text as UTF-8 so the SVG parses", () => {
    const content = svg("café")

    render(<ChangedFilesView changes={[svgChange({ changeType: "added", newContent: content })]} />)

    const src = screen.getByAltText("logo.svg").getAttribute("src")
    expect(decodeDataUri(src)).toBe(content)
    // "é" as the two UTF-8 bytes C3 A9, not the single Latin-1 byte E9.
    expect(src).toContain("caf%C3%A9")
  })
})
