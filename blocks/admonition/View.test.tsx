import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AdmonitionProps } from "./block.ts"
import { AdmonitionView } from "./View.tsx"

// What Admonition's view draws from its props. Closing and confirming,
// which need a page to click in, are e2e/admonition.spec.ts's.

const drawn = (props: AdmonitionProps, children?: string) =>
  renderToStaticMarkup(
    <AdmonitionView props={props}>
      {children === undefined ? null : <p>{children}</p>}
    </AdmonitionView>,
  )

describe("Admonition's view", () => {
  it("draws each type as a note named for it, headed by its title or else by that name", () => {
    expect(drawn({ type: "note" })).toContain('role="note" aria-label="Note"')
    expect(drawn({ type: "info" })).toContain('aria-label="Info"')
    expect(drawn({ type: "warning" })).toContain('aria-label="Warning"')
    expect(drawn({ type: "danger" })).toContain('aria-label="Danger"')
    expect(drawn({ type: "warning" })).toContain('<p class="mb-2 font-semibold">Warning</p>')
    expect(drawn({ type: "warning", title: "" })).toContain(
      '<p class="mb-2 font-semibold">Warning</p>',
    )
    expect(drawn({ type: "warning", title: "Careful" })).toContain(
      '<p class="mb-2 font-semibold">Careful</p>',
    )
  })

  it("colors each type's box its own way", () => {
    expect(drawn({ type: "note" })).toContain("border-zinc-300 bg-zinc-50")
    expect(drawn({ type: "info" })).toContain("border-sky-300 bg-sky-50")
    expect(drawn({ type: "warning" })).toContain("border-amber-300 bg-amber-50")
    expect(drawn({ type: "danger" })).toContain("border-red-300 bg-red-50")
  })

  it("shows its description, then the markdown written inside it", () => {
    expect(
      drawn({ type: "info", description: "It costs money." }, "Read the pricing page."),
    ).toContain("<p>It costs money.</p><p>Read the pricing page.</p>")
  })

  it("offers a close button only when closable", () => {
    expect(drawn({ type: "note", closable: true })).toContain('aria-label="Close"')
    expect(drawn({ type: "note", closable: false })).not.toContain("Close")
    expect(drawn({ type: "note" })).not.toContain("<button")
  })

  it("offers its confirmation as a button, red for a warning or a danger", () => {
    const button = (type: AdmonitionProps["type"]) =>
      /<button type="button" class="([^"]*)">I understand<\/button>/.exec(
        drawn({ type, confirmationText: "I understand" }),
      )?.[1]
    expect(button("note")).toContain("bg-zinc-800")
    expect(button("info")).toContain("bg-sky-700")
    expect(button("warning")).toContain("bg-red-700")
    expect(button("danger")).toContain("bg-red-700")
  })
})
