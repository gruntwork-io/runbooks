import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { BlockView, DocumentBlock, type DocumentView } from "@runbooks/core/protocol"
import { scrollToBlock } from "./frame.tsx"
import { type Following, FollowingContext } from "./following.ts"
import { makeLiveStore } from "./live.ts"
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

/** A block's view as the engine sends it, for `following`. */
const view = (
  block: string,
  status: Record<string, unknown>,
  fields: Record<string, unknown> = {},
) =>
  Schema.decodeUnknownSync(BlockView)({
    block,
    tag: "Example",
    class: "task",
    status,
    actions: [],
    outputs: {},
    ...fields,
  })

/** The window following a session the engine holds `views` of, as `follow` would show it. */
const followingViews = (...views: BlockView[]): Following => {
  const live = makeLiveStore()
  live.set({ blocks: new Map(views.map((shown) => [shown.block, shown])) })
  return { live, act: () => Effect.succeed(undefined) }
}

/** The page with `blocks` in it, in order, the window following `following`. */
const page = (following: Following, ...blocks: DocumentBlock[]) =>
  renderToStaticMarkup(
    <FollowingContext value={following}>
      <Markdown
        document={{
          tree: {
            type: "root",
            children: blocks.map((_, index) => ({ type: "block", index, children: [] })),
          },
          blocks: blocks.map((block, index) => ({ ...block, index })),
        }}
        runbook={RUNBOOK}
        session={SESSION}
      />
    </FollowingContext>,
  )

describe("a block's frame, as the engine has the block", () => {
  it.each([
    [{ _tag: "Idle" }, "Ready"],
    [{ _tag: "NeedsInput", fields: ["region", "token"] }, "Needs input: region, token"],
    [{ _tag: "Running" }, "Running"],
    [{ _tag: "Done", outcome: "success" }, "Done"],
    [{ _tag: "Done", outcome: "warning" }, "Done, with warnings"],
    [
      { _tag: "Failed", error: { _tag: "TaskFailed", message: "tofu exited", exitCode: 1 } },
      "Failed: tofu exited (exit code 1)",
    ],
    [{ _tag: "Failed", error: { _tag: "TaskCancelled" } }, "Cancelled"],
    [
      { _tag: "Failed", error: { _tag: "TaskTimedOut", afterMillis: 90_000 } },
      "Timed out after 90 seconds",
    ],
    [
      { _tag: "Failed", error: { _tag: "PropError", prop: "path", message: "names no file" } },
      "Failed: `path` names no file",
    ],
    [
      { _tag: "Failed", error: { _tag: "TaskBlocked", by: ["build", "test"] } },
      "Failed: it was blocked by build, test",
    ],
    [
      {
        _tag: "Failed",
        error: {
          _tag: "PathOutsideRoot",
          root: "working",
          path: "../x",
          message: "../x is outside the working folder",
        },
      },
      "Failed: ../x is outside the working folder",
    ],
    [
      {
        _tag: "Failed",
        error: { _tag: "CredentialError", kind: "expired", message: "The session expired." },
      },
      "Failed: The session expired.",
    ],
    [{ _tag: "Misconfigured" }, "Its configuration has errors, so it doesn&#x27;t run."],
  ])("shows the status %j as %s", (status, shown) => {
    expect(page(followingViews(view("setup", status)), placed({ id: "setup" }))).toContain(
      `<p class="block-status">${shown}</p>`,
    )
  })

  it("shows no status for a block the engine has not sent yet, or one with no lifecycle", () => {
    expect(page(followingViews(), placed({ id: "setup" }))).not.toContain("block-status")
    expect(page(followingViews(), placed({ class: "display", step: false }))).not.toContain(
      "block-status",
    )
  })

  it("marks a step done once its block is done, and not before", () => {
    const done = followingViews(view("setup", { _tag: "Done", outcome: "success" }))
    expect(page(done, placed({ id: "setup" }))).toContain('aria-label="Step: done"')
    const failed = followingViews(
      view("setup", { _tag: "Failed", error: { _tag: "TaskCancelled" } }),
    )
    expect(page(failed, placed({ id: "setup" }))).toContain('aria-label="Step: not done"')
  })

  it("says it waits for trust, and links each block it waits for, which scrolls to it", () => {
    const shown = page(
      followingViews(
        view("deploy", {
          _tag: "Blocked",
          by: [
            { _tag: "Untrusted" },
            { _tag: "WaitingFor", block: "build", capability: "run" },
            { _tag: "WaitingFor", block: "config", capability: "values" },
          ],
        }),
      ),
      placed({ id: "deploy" }),
      placed({ id: "build" }),
      placed({ id: "config", class: "form" }),
    )
    expect(shown).toContain("Waiting for you to trust this runbook.")
    expect(shown).toContain("Waiting for:")
    expect(shown).toContain(
      '<a href="#runbook-block-build" class="block-link">build</a> to run successfully',
    )
    expect(shown).toContain(
      '<a href="#runbook-block-config" class="block-link">config</a> to have its values',
    )
  })

  it("names a block it waits for as text when the page draws no frame for it", () => {
    const shown = page(
      followingViews(
        view("deploy", {
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: "gone", capability: "run" }],
        }),
      ),
      placed({ id: "deploy" }),
    )
    expect(shown).toContain('<code class="block-link">gone</code> to run successfully')
  })

  it("scrolls a block's frame to the middle of the window", () => {
    const scrolled: Array<[string, ScrollIntoViewOptions]> = []
    scrollToBlock(
      {
        getElementById: (id) => ({ scrollIntoView: (options) => scrolled.push([id, options]) }),
      },
      "build",
    )
    expect(scrolled).toEqual([["runbook-block-build", { behavior: "smooth", block: "center" }]])
  })

  it("folds a done task or credential block that asks to, to its header", () => {
    const done = { _tag: "Done", outcome: "success" }
    for (const kind of ["task", "credential"]) {
      const shown = page(
        followingViews(view("setup", done, { class: kind })),
        placed({ id: "setup", class: kind, autoCollapse: true, description: "Sets it up." }),
      )
      expect(shown).toContain('data-folded="true"')
      expect(shown).toContain('aria-expanded="false"')
      expect(shown).toContain('<span class="block-id">setup</span>')
      expect(shown).not.toContain("Sets it up.")
    }
  })

  it("does not fold a block that is not done, one that doesn't ask to, or a form", () => {
    const shown = (fields: Record<string, unknown>, status: Record<string, unknown>) =>
      page(followingViews(view("setup", status, fields)), placed({ id: "setup", ...fields }))
    const done = { _tag: "Done", outcome: "success" }
    expect(shown({ autoCollapse: true }, { _tag: "Running" })).not.toContain('data-folded="true"')
    expect(shown({}, done)).not.toContain('data-folded="true"')
    expect(shown({ autoCollapse: false }, done)).not.toContain('data-folded="true"')
    expect(shown({ autoCollapse: true, class: "form" }, done)).not.toContain('data-folded="true"')
  })
})
