import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentBlock, type DocumentView } from "@runbooks/core/protocol"
import { Markdown } from "./markdown.tsx"

// The frame the walk draws each block in, over document blocks as the
// engine sends them, rendered to the markup the page would hold.

type TreeNode = DocumentView["tree"]

const RUNBOOK = "/work/demo/runbook.mdx"
const SESSION = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const SPAN = { start: { line: 3, column: 1 }, end: { line: 5, column: 3 } }

const placed = (fields: Record<string, unknown>): DocumentBlock =>
  Schema.decodeUnknownSync(DocumentBlock)({
    _tag: "Configured",
    index: 0,
    tag: "Example",
    block: "Example",
    class: "task",
    span: SPAN,
    step: true,
    ...fields,
  })

const text = (value: string): TreeNode => ({
  type: "paragraph",
  children: [{ type: "text", value }],
})

/** The page with `block` alone in it, `children` as its markdown. */
const framed = (block: DocumentBlock, ...children: TreeNode[]) =>
  renderToStaticMarkup(
    <Markdown
      document={{
        tree: { type: "root", children: [{ type: "block", index: 0, children }] },
        blocks: [block],
      }}
      runbook={RUNBOOK}
      session={SESSION}
    />,
  )

describe("a block's frame", () => {
  it("marks a progress step, and draws no mark on a block that is not one", () => {
    expect(framed(placed({ id: "setup" }))).toContain('aria-label="Step: not done"')
    expect(framed(placed({ class: "display", step: false }))).not.toContain("Step:")
    expect(framed(placed({ id: "peek", step: false }))).not.toContain("Step:")
  })

  it("draws a misconfigured block with no step mark: it is never a step", () => {
    const shown = framed(
      placed({
        _tag: "Misconfigured",
        id: "setup",
        errors: [
          {
            _tag: "ConfigError",
            code: "badProp",
            message: "set `command`",
            location: { file: RUNBOOK, span: SPAN },
          },
        ],
      }),
    )
    expect(shown).toContain("Line 3: set `command`")
    expect(shown).not.toContain("Step:")
  })

  it("gives a block with an id an anchor that a link to it scrolls to", () => {
    expect(framed(placed({ id: "setup" }))).toContain('id="runbook-block-setup"')
  })

  it("draws a task's markdown in its body", () => {
    expect(framed(placed({ id: "setup" }), text("Runs the setup."))).toContain(
      '<div class="block-body"><p>Runs the setup.</p></div>',
    )
  })

  it("draws a form or a credential block with no view, its markdown, and a line that says so", () => {
    const form = framed(placed({ id: "config", class: "form" }), text("Your settings."))
    expect(form).toContain("Your settings.")
    expect(form).toContain("The window can&#x27;t show this form&#x27;s fields yet.")
    const credential = framed(placed({ id: "cloud", class: "credential" }), text("Sign in first."))
    expect(credential).toContain("Sign in first.")
    expect(credential).toContain("The window can&#x27;t show this sign-in yet.")
  })

  it("draws a display block's markdown, with no status and no step", () => {
    const shown = framed(placed({ class: "display", step: false }), text("Read this first."))
    expect(shown).toContain("Read this first.")
    expect(shown).not.toContain("can&#x27;t show")
  })
})
