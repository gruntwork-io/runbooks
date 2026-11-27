import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { BlockView, DocumentBlock, Settings } from "@runbooks/core/protocol"
import { type Following, FollowingContext } from "./following.ts"
import { makeLiveStore } from "./live.ts"
import { Markdown } from "./markdown.tsx"
import { makeSettingsStore } from "./settings.ts"
import { makeTrustingStore } from "./trust.ts"

// A block's "Script changed" notice, over a block whose view has files on
// disk as the engine sends them, rendered to the markup the page would hold.

const RUNBOOK = "/work/demo/runbook.mdx"
const SESSION = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const HASH = `sha256:${"4".repeat(64)}`
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
}

/** The page with `block` alone in it, its view holding `onDisk` as its files on disk. */
const page = (
  onDisk: Record<string, unknown> | undefined,
  block: DocumentBlock = placed(),
  { status = { _tag: "Idle" }, instructionMode = false }: Shown = {},
) => {
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
  live.set({ blocks: new Map([["greet", view]]) })
  const following: Following = {
    live,
    settings: makeSettingsStore(
      Schema.decodeUnknownSync(Settings)({ ...SETTINGS, instructionMode }),
    ),
    trusting: makeTrustingStore(),
    act: () => Effect.succeed(undefined),
    trust: () => Effect.void,
  }
  return renderToStaticMarkup(
    <FollowingContext value={following}>
      <Markdown
        document={{
          tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
          blocks: [block],
        }}
        runbook={RUNBOOK}
        session={SESSION}
      />
    </FollowingContext>,
  )
}

/** The text of the diff, as a test reading the page's text gets it. */
const diffOf = (markup: string) =>
  (/data-testid="script-change-diff">(.*?)<\/div><\/section>/s.exec(markup)?.[1] ?? "")
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
