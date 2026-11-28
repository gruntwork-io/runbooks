import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import type { ViewRequest } from "@runbooks/blocks/views"
import { BlockView, DocumentBlock, Settings } from "@runbooks/core/protocol"
import type { Following } from "./following.ts"
import { makeLiveStore } from "./live.ts"
import { makeReloadingStore } from "./reload.ts"
import { NO_SCRIPT_FILES } from "./scriptFiles.ts"
import { makeSettingsStore } from "./settings.ts"
import { installDom } from "./testDom.ts"
import { makeTrustingStore } from "./trust.ts"

// A form block's frame as a person uses it, in a jsdom page (testDom.ts):
// what it draws from the engine's view, and what it asks the engine for.
const uninstall = installDom()
afterAll(uninstall)
const { cleanup, render, screen } = await import("@testing-library/react")
const { userEvent } = await import("@testing-library/user-event")
const { FollowingContext } = await import("./following.ts")
const { Markdown } = await import("./markdown.tsx")
afterEach(cleanup)

const FORM = Schema.decodeUnknownSync(DocumentBlock)({
  _tag: "Configured",
  index: 0,
  id: "config",
  tag: "Example",
  block: "Example",
  class: "form",
  span: { start: { line: 3, column: 1 }, end: { line: 5, column: 3 } },
  step: true,
  effects: [],
})

const viewOf = (status: Record<string, unknown>, actions: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(BlockView)({
    block: "config",
    tag: "Example",
    class: "form",
    status,
    actions,
    outputs: {},
    fields: [
      {
        name: "region",
        type: "string",
        description: { type: "root", children: [] },
        required: true,
        sensitive: false,
        readOnly: false,
        validations: [],
        reviewed: false,
        unresolved: [],
      },
    ],
  })

/** The page with the form alone in it, the engine holding `view` of it; each request is kept, and answered at once. */
function page(view: BlockView, instructionMode = false) {
  const asked: ViewRequest[] = []
  const live = makeLiveStore()
  live.set({ blocks: new Map([[view.block, view]]), instructionMode })
  const following: Following = {
    live,
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
      }),
    ),
    trusting: makeTrustingStore(),
    reloading: makeReloadingStore(),
    scriptFiles: NO_SCRIPT_FILES,
    act: (_, request) => Effect.sync(() => (asked.push(request), undefined)),
    trust: () => Effect.void,
    reload: () => Effect.void,
  }
  render(
    <FollowingContext value={following}>
      <Markdown
        document={{
          tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
          blocks: [FORM],
        }}
        runbook="/work/runbook.mdx"
        session="s-1"
      />
    </FollowingContext>,
  )
  return asked
}

describe("a form block's frame", () => {
  it("sends the values typed, then Submit as a run and Undo Submit as a reset", async () => {
    const user = userEvent.setup()
    const asked = page(viewOf({ _tag: "Done", outcome: "success" }, ["run", "reset", "setValues"]))
    expect(screen.getByText("Done").className).toBe("block-status")
    await user.type(screen.getByRole("textbox", { name: "Region*" }), "eu")
    await user.click(screen.getByRole("button", { name: "Submit" }))
    await user.click(screen.getByRole("button", { name: "Undo Submit" }))
    expect(asked).toEqual([
      { _tag: "SetValues", values: { region: "e" } },
      { _tag: "SetValues", values: { region: "eu" } },
      { _tag: "RunBlock" },
      { _tag: "ResetBlock" },
    ])
  })

  it("in instruction mode, takes the values typed and offers no Submit or Reset", async () => {
    const user = userEvent.setup()
    const asked = page(viewOf({ _tag: "Idle" }, ["run", "setValues"]), true)
    expect(screen.getByText("Ready").className).toBe("block-status")
    await user.type(screen.getByRole("textbox", { name: "Region*" }), "e")
    expect(screen.queryAllByRole("button")).toEqual([])
    expect(asked).toEqual([{ _tag: "SetValues", values: { region: "e" } }])
  })
})
