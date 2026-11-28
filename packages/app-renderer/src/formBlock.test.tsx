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
const { act, cleanup, render, screen } = await import("@testing-library/react")
const { userEvent } = await import("@testing-library/user-event")
const { FollowingContext } = await import("./following.ts")
const { Markdown } = await import("./markdown.tsx")
afterEach(cleanup)

const placed = (kind: "form" | "task") =>
  Schema.decodeUnknownSync(DocumentBlock)({
    _tag: "Configured",
    index: 0,
    id: "config",
    tag: "Example",
    block: "Example",
    class: kind,
    span: { start: { line: 3, column: 1 }, end: { line: 5, column: 3 } },
    step: true,
    effects: [],
  })

/** The form's one field, holding `value` if given. */
const regionField = (value?: string) => ({
  name: "region",
  type: "string",
  description: { type: "root", children: [] },
  required: true,
  sensitive: false,
  readOnly: false,
  validations: [],
  reviewed: false,
  unresolved: [],
  ...(value === undefined ? {} : { value: { _tag: "Shown", value } }),
})

const viewOf = (
  status: Record<string, unknown>,
  actions: ReadonlyArray<string>,
  rest: Record<string, unknown> = {},
) =>
  Schema.decodeUnknownSync(BlockView)({
    block: "config",
    tag: "Example",
    class: "form",
    status,
    actions,
    outputs: {},
    fields: [regionField()],
    ...rest,
  })

/**
 * The page with the block alone in it, the engine holding `view` of it; each
 * request is kept, and answered at once. Each value entered logs one event
 * after the view's, and its answer says `said`.
 */
function page(view: BlockView, instructionMode = false, said?: string) {
  const asked: ViewRequest[] = []
  let logged = view.sequence ?? -1
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
        hiddenInRunbooks: [],
      }),
    ),
    trusting: makeTrustingStore(),
    reloading: makeReloadingStore(),
    scriptFiles: NO_SCRIPT_FILES,
    act: (_, request) => Effect.sync(() => (asked.push(request), undefined)),
    enter: (_, values) =>
      Effect.sync(() => {
        asked.push({ _tag: "SetValues", values })
        logged += 1
        return { said, sequence: logged }
      }),
    trust: () => Effect.void,
    reload: () => Effect.void,
  }
  render(
    <FollowingContext value={following}>
      <Markdown
        document={{
          tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
          blocks: [placed(view.class === "task" ? "task" : "form")],
        }}
        runbook="/work/runbook.mdx"
        session="s-1"
      />
    </FollowingContext>,
  )
  return { asked, live }
}

describe("a form block's frame", () => {
  it("sends the values typed, then Submit as a run and Undo Submit as a reset", async () => {
    const user = userEvent.setup()
    const { asked } = page(
      viewOf({ _tag: "Done", outcome: "success" }, ["run", "reset", "setValues"]),
    )
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
    const { asked } = page(viewOf({ _tag: "Idle" }, ["run", "setValues"]), true)
    expect(screen.getByText("Ready").className).toBe("block-status")
    await user.type(screen.getByRole("textbox", { name: "Region*" }), "e")
    expect(screen.queryAllByRole("button")).toEqual([])
    expect(asked).toEqual([{ _tag: "SetValues", values: { region: "e" } }])
  })

  it("says what the engine answered the values typed with", async () => {
    const user = userEvent.setup()
    page(viewOf({ _tag: "Idle" }, ["run", "setValues"]), false, "region: It is read-only.")
    await user.type(screen.getByRole("textbox", { name: "Region*" }), "e")
    expect(screen.getByText("region: It is read-only.").className).toBe("block-said")
  })

  it.each(["form", "task"])(
    "shows, in a %s's fields, another writer's value once a view is read at or after the answer to what was typed",
    async (kind) => {
      const user = userEvent.setup()
      const viewAt = (sequence: number, fields?: ReadonlyArray<unknown>) =>
        viewOf({ _tag: "Idle" }, ["run", "setValues"], {
          class: kind,
          sequence,
          ...(fields === undefined ? {} : { fields }),
        })
      const { live } = page(viewAt(4))
      const box = screen.getByRole("textbox", { name: "Region*" }) as HTMLInputElement
      // The engine answers at 5.
      await user.type(box, "e")
      const shown = (sequence: number) =>
        act(() =>
          live.set({ blocks: new Map([["config", viewAt(sequence, [regionField("us")])]]) }),
        )
      shown(4)
      expect(box.value).toBe("e")
      shown(5)
      expect(box.value).toBe("us")
    },
  )
})

describe("a task's own form", () => {
  it("draws the task's fields above Run, and sends their values and the run", async () => {
    const user = userEvent.setup()
    const { asked } = page(viewOf({ _tag: "Idle" }, ["run", "setValues"], { class: "task" }))
    const region = screen.getByRole("textbox", { name: "Region*" })
    const run = screen.getByRole("button", { name: "Run" })
    expect(region.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull()
    await user.type(region, "e")
    await user.click(run)
    expect(asked).toEqual([{ _tag: "SetValues", values: { region: "e" } }, { _tag: "RunBlock" }])
  })

  it("in instruction mode, draws the fields above the instruction and takes their values", async () => {
    const user = userEvent.setup()
    const instruction = [{ kind: "code", language: "bash", code: "deploy --region eu" }]
    const { asked } = page(
      viewOf({ _tag: "Idle" }, ["run", "setValues"], { class: "task", instruction }),
      true,
    )
    const region = screen.getByRole("textbox", { name: "Region*" })
    const command = screen.getByText("deploy --region eu")
    expect(region.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryAllByRole("button")).toEqual([])
    await user.type(region, "e")
    expect(asked).toEqual([{ _tag: "SetValues", values: { region: "e" } }])
  })
})
