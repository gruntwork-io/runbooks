import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentView, SessionSummary } from "@runbooks/core/protocol"
import { Runbook } from "./runbook.tsx"

// The runbook page over a document and session as the engine sends them.

const RUNBOOK = "/work/demo/runbook.mdx"

const session = Schema.decodeUnknownSync(SessionSummary)({
  session: "s-1",
  name: "demo",
  path: RUNBOOK,
  blocks: 0,
})

const document = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(DocumentView)({
    tree: {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Body." }] }],
    },
    blocks: [],
    warnings: [],
    ...fields,
  })

const page = (fields: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<Runbook session={session} document={document(fields)} />)

describe("the runbook page", () => {
  it("is headed by the front matter's title, and holds the walked body", () => {
    const shown = page({ title: "Deploy the VPC" })
    expect(shown).toContain("<h1>Deploy the VPC</h1>")
    expect(shown).toContain('<div class="runbook-body" style="contain:paint"><p>Body.</p></div>')
  })

  it("keeps its title and warnings outside the body's box", () => {
    const shown = page({ title: "Deploy the VPC" })
    expect(shown.indexOf("<h1>")).toBeLessThan(shown.indexOf('class="runbook-body"'))
  })

  it("is headed by the session's name when the front matter has no title", () => {
    expect(page()).toContain("<h1>demo</h1>")
  })

  it("shows each warning with its line", () => {
    const shown = page({
      warnings: [
        {
          _tag: "ConfigWarning",
          code: "unknownProp",
          message: "<Example> has no `colour` prop, so it is ignored.",
          location: {
            file: RUNBOOK,
            span: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
          },
        },
      ],
    })
    expect(shown).toContain("Line 4: &lt;Example&gt; has no `colour` prop, so it is ignored.")
  })

  it("says how many parts it shows only as text, and which", () => {
    const shown = page({
      tree: {
        type: "root",
        children: [
          { type: "mdxJsxFlowElement", name: "button", props: {}, children: [] },
          { type: "mdxJsxFlowElement", name: "button", props: {}, children: [] },
          { type: "math", value: "x" },
        ],
      },
    })
    expect(shown).toContain("can&#x27;t show 3 parts of the runbook yet")
    expect(shown).toContain("&lt;button&gt; (2), math (1)")
  })

  it("says nothing of such parts when there are none", () => {
    expect(page()).not.toContain("can&#x27;t show")
  })
})
