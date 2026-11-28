import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentView, SessionSummary, Settings } from "@runbooks/core/protocol"
import { type Following, FollowingContext } from "./following.ts"
import { type Live, makeLiveStore } from "./live.ts"
import { makeReloadingStore } from "./reload.ts"
import { NO_SCRIPT_FILES } from "./scriptFiles.ts"
import { Runbook } from "./runbook.tsx"
import { makeSettingsStore } from "./settings.ts"
import { makeTrustingStore } from "./trust.ts"

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
    hash: `sha256:${"0".repeat(64)}`,
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

/** A task block with `id`, at `index`, as the document places it. */
const taskAt = (index: number, id: string) => ({
  _tag: "Configured",
  index,
  tag: "Example",
  block: "Example",
  class: "task",
  id,
  span: { start: { line: 3, column: 1 }, end: { line: 3, column: 20 } },
  step: true,
  effects: [],
})

/** The window following a session as `live` shows it. */
const followingWith = (live: Live): Following => {
  const store = makeLiveStore()
  store.set(live)
  return {
    live: store,
    settings: makeSettingsStore(undefined),
    trusting: makeTrustingStore(),
    reloading: makeReloadingStore(),
    scriptFiles: NO_SCRIPT_FILES,
    act: () => Effect.succeed(undefined),
    enter: () => Effect.succeed({ said: undefined, sequence: undefined }),
    trust: () => Effect.void,
    reload: () => Effect.void,
  }
}

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

  it("draws the runbook the window follows, once the session reloaded it, in place of the one it opened with", () => {
    const opened = document({
      title: "Before",
      tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
      blocks: [taskAt(0, "removed")],
    })
    const reloaded = document({
      hash: `sha256:${"1".repeat(64)}`,
      title: "After",
      tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
      blocks: [taskAt(0, "added")],
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
    const shown = renderToStaticMarkup(
      <FollowingContext value={followingWith({ blocks: new Map(), document: reloaded })}>
        <Runbook session={session} document={opened} />
      </FollowingContext>,
    )
    expect(shown).toContain("<h1>After</h1>")
    expect(shown).toContain('id="runbook-block-added"')
    expect(shown).toContain("Line 4: &lt;Example&gt; has no `colour` prop")
    expect(shown).not.toContain("Before")
    expect(shown).not.toContain("removed")
  })

  it("draws the runbook it opened with until the window has read the session", () => {
    const shown = renderToStaticMarkup(
      <FollowingContext value={followingWith({ blocks: new Map() })}>
        <Runbook session={session} document={document({ title: "Before" })} />
      </FollowingContext>,
    )
    expect(shown).toContain("<h1>Before</h1>")
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

  it("says when it is in instruction mode, above the runbook's box, and not when it isn't", () => {
    const inMode = (instructionMode: boolean) =>
      renderToStaticMarkup(
        <FollowingContext
          value={{
            live: makeLiveStore(),
            settings: makeSettingsStore(
              Schema.decodeUnknownSync(Settings)({
                theme: "system",
                instructionMode,
                runbookWidth: null,
                askAboutGeneratedFiles: true,
                caBundleFile: null,
                proxy: null,
                agentAccess: false,
                confirmAgentRuns: true,
                recentGitHubHosts: [],
                lastSelectedGitHubHost: null,
                recentGitLabHosts: [],
                lastSelectedGitLabHost: null,
                hiddenInRunbooks: [],
              }),
            ),
            trusting: makeTrustingStore(),
            reloading: makeReloadingStore(),
            scriptFiles: NO_SCRIPT_FILES,
            act: () => Effect.succeed(undefined),
            enter: () => Effect.succeed({ said: undefined, sequence: undefined }),
            trust: () => Effect.void,
            reload: () => Effect.void,
          }}
        >
          <Runbook session={session} document={document({})} />
        </FollowingContext>,
      )
    const banner =
      "Instruction mode: nothing here runs automatically. Each step shows the exact command to copy and run yourself."
    const shown = inMode(true)
    expect(shown).toContain(banner)
    expect(shown.indexOf(banner)).toBeLessThan(shown.indexOf('class="runbook-body"'))
    expect(inMode(false)).not.toContain(banner)
  })
})
