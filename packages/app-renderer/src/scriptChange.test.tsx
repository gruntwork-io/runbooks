import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { BlockView, DocumentBlock, DocumentView, Settings } from "@runbooks/core/protocol"
import { type Following, FollowingContext } from "./following.ts"
import { makeLiveStore } from "./live.ts"
import { Markdown } from "./markdown.tsx"
import { makeReloadingStore, type Reloading } from "./reload.ts"
import { NO_SCRIPT_FILES } from "./scriptFiles.ts"
import { makeSettingsStore } from "./settings.ts"
import { makeTrustingStore } from "./trust.ts"

// A block's "Script changed" notice, over a block whose view has files on
// disk as the engine sends them, rendered to the markup the page would hold.

const RUNBOOK = "/work/demo/runbook.mdx"
const SESSION = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const HASH = `sha256:${"4".repeat(64)}`
const DRAWN = `sha256:${"7".repeat(64)}`
const blockId = Schema.decodeSync(BlockView.fields.block)
const SPAN = { start: { line: 3, column: 1 }, end: { line: 3, column: 30 } }

const SETTINGS = {
  theme: "system",
  instructionMode: false,
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
}

/** The `greet` block as the document places it. */
const placed = (fields: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(DocumentBlock)({
    _tag: "Configured",
    index: 0,
    tag: "Example",
    block: "Example",
    class: "task",
    id: "greet",
    span: SPAN,
    step: true,
    effects: [],
    ...fields,
  })

/** greet.sh as the session holds it, and as it is on disk, where a line above the change went. */
const MODIFIED = {
  _tag: "Changed",
  path: "greet.sh",
  change: "modified",
  hunks: [
    {
      heldLine: 4,
      diskLine: 3,
      lines: [
        { kind: "context", text: "#!/bin/bash" },
        { kind: "deletion", text: "echo script-before" },
        { kind: "addition", text: "echo script-after" },
      ],
    },
  ],
}

interface Shown {
  readonly status?: Record<string, unknown>
  readonly instructionMode?: boolean
  /** The blocks after `block` on the page. */
  readonly others?: ReadonlyArray<DocumentBlock>
  /** What came of the last ask to reload greet's files: for HASH, on the page drawn now, unless it says. */
  readonly reloaded?: {
    readonly answer: Reloading["answer"]
    readonly hash?: string
    readonly before?: boolean
  }
}

/** The page with `block` first in it, its view holding `onDisk` as its files on disk. */
const page = (
  onDisk: Record<string, unknown> | undefined,
  block: DocumentBlock = placed(),
  { status = { _tag: "Idle" }, instructionMode = false, others = [], reloaded }: Shown = {},
) => {
  const blocks = [block, ...others]
  const drawn = Schema.decodeUnknownSync(DocumentView)({
    hash: DRAWN,
    tree: {
      type: "root",
      children: blocks.map((_, index) => ({ type: "block", index, children: [] })),
    },
    blocks,
    warnings: [],
  })
  const live = makeLiveStore()
  const view = Schema.decodeUnknownSync(BlockView)({
    block: "greet",
    tag: "Example",
    class: block.class,
    status,
    actions: ["run"],
    outputs: {},
    ...(onDisk === undefined ? {} : { filesOnDisk: { hash: HASH, ...onDisk } }),
  })
  live.set({ blocks: new Map([["greet", view]]), document: drawn })
  const reloading = makeReloadingStore()
  if (reloaded !== undefined)
    reloading.set(blockId("greet"), {
      hash: Schema.decodeUnknownSync(DocumentView)({ ...drawn, hash: reloaded.hash ?? HASH }).hash,
      drawn: reloaded.before === true ? { ...drawn } : drawn,
      answer: reloaded.answer,
    })
  const following: Following = {
    live,
    settings: makeSettingsStore(
      Schema.decodeUnknownSync(Settings)({ ...SETTINGS, instructionMode }),
    ),
    trusting: makeTrustingStore(),
    reloading,
    scriptFiles: NO_SCRIPT_FILES,
    act: () => Effect.succeed(undefined),
    enter: () => Effect.succeed({ said: undefined, sequence: undefined }),
    trust: () => Effect.void,
    reload: () => Effect.void,
  }
  return renderToStaticMarkup(
    <FollowingContext value={following}>
      <Markdown document={drawn} runbook={RUNBOOK} session={SESSION} />
    </FollowingContext>,
  )
}

/** The text of the diff, as a test reading the page's text gets it. */
const diffOf = (markup: string) =>
  (
    /data-testid="script-change-diff">(.*?)<\/div><div class="script-change-actions">/s.exec(
      markup,
    )?.[1] ?? ""
  )
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#x27;", "'")

describe("a block's Script changed notice", () => {
  it("shows how a file the block names changed on disk, each line signed as a diff signs it", () => {
    const shown = page({ files: [MODIFIED] })
    expect(shown).toContain('aria-label="Script changed"')
    expect(shown).toContain("<strong>Script changed</strong>")
    expect(shown).toContain(
      "The files below changed on disk since Runbooks read them. Until you reload the script, the block keeps the version Runbooks read. Review the change first.",
    )
    expect(diffOf(shown)).toBe(
      "greet.sh changed@@ -4 +3 @@\n #!/bin/bash\n-echo script-before\n+echo script-after",
    )
  })

  it("says a file is new, or was deleted, and why the session can't take one as it is", () => {
    const diff = diffOf(
      page({
        files: [
          {
            _tag: "Unreadable",
            path: "big.sh",
            reason: "big.sh is over the 1 MiB limit on a file a block names.",
          },
          {
            _tag: "Changed",
            path: "old.sh",
            change: "deleted",
            hunks: [{ heldLine: 1, diskLine: 1, lines: [{ kind: "deletion", text: "echo old" }] }],
          },
          {
            _tag: "Changed",
            path: "templates/b.txt",
            change: "created",
            hunks: [{ heldLine: 1, diskLine: 1, lines: [{ kind: "addition", text: "b" }] }],
          },
        ],
      }),
    )
    expect(diff).toBe(
      "big.sh is over the 1 MiB limit on a file a block names." +
        "old.sh was deleted@@ -1 +1 @@\n-echo old" +
        "templates/b.txt is new@@ -1 +1 @@\n+b",
    )
  })

  it("says when no line differs, and when a file is empty", () => {
    const diff = diffOf(
      page({
        files: [
          { _tag: "Changed", path: "a.sh", change: "modified", hunks: [] },
          { _tag: "Changed", path: "empty.txt", change: "created", hunks: [] },
        ],
      }),
    )
    expect(diff).toBe(
      "a.sh changedIts lines are the same: only line endings, a final newline or the file's mode differ." +
        "empty.txt is newIt is empty.",
    )
  })

  it("says nothing of the lines of the file a cut diff ends in, which the cut left out", () => {
    const diff = diffOf(
      page({
        files: [
          { _tag: "Changed", path: "a.sh", change: "modified", hunks: [] },
          MODIFIED,
          { _tag: "Changed", path: "long.sh", change: "modified", hunks: [] },
        ],
        truncated: true,
      }),
    )
    expect(diff).toStartWith(
      "a.sh changedIts lines are the same: only line endings, a final newline or the file's mode differ.",
    )
    expect(diff).toEndWith("long.sh changed")
  })

  it.each([
    ["a form", placed({ class: "form" }), {}],
    [
      "a misconfigured block, whose file came back",
      placed({
        _tag: "Misconfigured",
        errors: [
          {
            _tag: "ConfigError",
            code: "badFile",
            message: "greet.sh is missing.",
            location: { file: RUNBOOK, span: SPAN },
          },
        ],
      }),
      { status: { _tag: "Misconfigured" } },
    ],
    ["a task in instruction mode", placed(), { instructionMode: true }],
  ] as const)("shows on %s too", (_, block, shown) => {
    const markup = page({ files: [MODIFIED] }, block, shown)
    expect(markup).toContain("<strong>Script changed</strong>")
    expect(diffOf(markup)).toContain("+echo script-after")
  })

  it("is not shown while the block's files are as the session holds them", () => {
    expect(page(undefined)).not.toContain("Script changed")
  })

  it("folds with its block, as the old app's did", () => {
    const shown = page({ files: [MODIFIED] }, placed({ autoCollapse: true }), {
      status: { _tag: "Done", outcome: "success" },
    })
    expect(shown).toContain('data-folded="true"')
    expect(shown).not.toContain("Script changed")
  })
})

/** What the notice shows under its diff: its button or why there is none, the cut note, and the last answer. */
const actionsOf = (markup: string) =>
  /<div class="script-change-actions">.*?<\/section>/s.exec(markup)?.[0] ?? ""

const BUTTON = '<button type="button" class="script-reload">Reload script</button>'
const OFF = '<button type="button" class="script-reload" disabled="">Reload script</button>'

describe("the notice's Reload script button", () => {
  it("offers to reload the files the block shows, and says nothing else", () => {
    expect(actionsOf(page({ files: [MODIFIED] }))).toBe(
      `<div class="script-change-actions">${BUTTON}</div></section>`,
    )
  })

  it.each([
    ["while the engine is asked", { _tag: "Asking" }],
    [
      "once the engine took them, until the page draws the runbook that holds them",
      { _tag: "Reloaded" },
    ],
  ] as const)("is off %s", (_, answer) => {
    expect(actionsOf(page({ files: [MODIFIED] }, placed(), { reloaded: { answer } }))).toBe(
      `<div class="script-change-actions">${OFF}</div></section>`,
    )
  })

  it("says the files changed again, while the diff the person reloaded still shows", () => {
    expect(
      actionsOf(
        page({ files: [MODIFIED] }, placed(), { reloaded: { answer: { _tag: "NotShown" } } }),
      ),
    ).toBe(
      `<div class="script-change-actions">${BUTTON}</div>` +
        '<p class="script-change-said">The files changed again. The newer change shows here once Runbooks reads it.</p></section>',
    )
  })

  it("says which running blocks it didn't reload for, each a link to its frame when the page draws it", () => {
    const shown = actionsOf(
      page({ files: [MODIFIED] }, placed(), {
        others: [placed({ index: 1, id: "deploy" })],
        reloaded: { answer: { _tag: "Running", blocks: [blockId("deploy"), blockId("cleanup")] } },
      }),
    )
    expect(shown).toBe(
      `<div class="script-change-actions">${BUTTON}</div>` +
        '<div class="script-change-said"><p>The script didn&#x27;t reload: nothing reloads while a block runs. Reload it once these stop:</p>' +
        '<ul><li><a href="#runbook-block-deploy" class="block-link">deploy</a></li><li><code class="block-link">cleanup</code></li></ul></div></section>',
    )
  })

  it("says why nothing was reloaded when the ask failed", () => {
    const failed = "This runbook's session closed, so nothing was reloaded."
    expect(
      actionsOf(
        page({ files: [MODIFIED] }, placed(), {
          reloaded: { answer: { _tag: "Failed", line: failed } },
        }),
      ),
    ).toBe(
      `<div class="script-change-actions">${BUTTON}</div>` +
        '<p class="script-change-said">This runbook&#x27;s session closed, so nothing was reloaded.</p></section>',
    )
  })

  it.each([
    ["for other files", { hash: `sha256:${"9".repeat(64)}` }],
    ["from a page drawn before this one", { before: true }],
  ] as const)("forgets an answer %s", (_, asked) => {
    for (const answer of [{ _tag: "Reloaded" }, { _tag: "NotShown" }] as const)
      expect(
        actionsOf(page({ files: [MODIFIED] }, placed(), { reloaded: { answer, ...asked } })),
      ).toBe(`<div class="script-change-actions">${BUTTON}</div></section>`)
  })

  it("says beside it when the diff is cut, and that it takes the whole change", () => {
    expect(actionsOf(page({ files: [MODIFIED], truncated: true }))).toBe(
      `<div class="script-change-actions">${BUTTON}` +
        '<span class="script-change-cut">The diff is cut short. Reload script takes the whole change, the part not shown too.</span></div></section>',
    )
  })

  it.each([
    ["a task", placed()],
    ["a form, which keeps its view", placed({ class: "form" })],
  ] as const)("is not offered in instruction mode, on %s", (_, block) => {
    expect(
      actionsOf(page({ files: [MODIFIED], truncated: true }, block, { instructionMode: true })),
    ).toBe(
      '<div class="script-change-actions"><p>Turn off instruction mode to reload the script.</p>' +
        '<span class="script-change-cut">The diff is cut short: the change goes on past it.</span></div></section>',
    )
  })
})
