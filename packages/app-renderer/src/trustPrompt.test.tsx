import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import {
  DocumentBlock,
  DocumentView,
  SessionSummary,
  Settings,
  TrustState,
} from "@runbooks/core/protocol"
import { type Following, FollowingContext } from "./following.ts"
import { makeLiveStore } from "./live.ts"
import { makeReloadingStore } from "./reload.ts"
import { NO_SCRIPT_FILES } from "./scriptFiles.ts"
import { Runbook } from "./runbook.tsx"
import { makeSettingsStore } from "./settings.ts"
import { makeTrustingStore, type Trusting } from "./trust.ts"

// The trust prompt on the runbook page, over a document and trust state as
// the engine sends them, rendered to the markup the page would hold.

const RUNBOOK = "/work/demo/runbook.mdx"
const HASH = `sha256:${"0".repeat(64)}`
const SPAN = { start: { line: 3, column: 1 }, end: { line: 5, column: 3 } }

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

const session = Schema.decodeUnknownSync(SessionSummary)({
  session: "s-1",
  name: "demo",
  path: RUNBOOK,
  blocks: 0,
})

const placed = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(DocumentBlock)({
    _tag: "Configured",
    index: 0,
    tag: "Example",
    block: "Example",
    class: "task",
    span: SPAN,
    step: true,
    effects: [],
    ...fields,
  })

const COMMAND = { tag: "Shell", id: "setup", title: "Set up", effects: ["process"] }
const SIGN_IN = {
  tag: "CloudAuth",
  id: "cloud",
  class: "credential",
  effects: ["network", "browser"],
}
const FORM = { tag: "Survey", id: "config", class: "form" }
const NOTE = { tag: "Note", class: "display", step: false }
const BROKEN = {
  _tag: "Misconfigured",
  tag: "Shell",
  id: "broken",
  errors: [
    {
      _tag: "ConfigError",
      code: "badProp",
      message: "`command` is not a string.",
      location: { file: RUNBOOK, span: SPAN },
    },
  ],
}

interface Shown {
  readonly trust?: { readonly trusted: boolean }
  readonly instructionMode?: boolean
  readonly ended?: string
  readonly trusting?: Trusting
}

/** The page holding `blocks`, the window following a session it shows as `shown` says. */
const page = (blocks: ReadonlyArray<Record<string, unknown>>, shown: Shown = {}) => {
  const { trust = { trusted: false }, instructionMode = false, ended, trusting = {} } = shown
  const live = makeLiveStore()
  live.set({
    blocks: new Map(),
    trust: Schema.decodeUnknownSync(TrustState)({ ...trust, hash: HASH }),
    ...(ended === undefined ? {} : { ended }),
  })
  const store = makeTrustingStore()
  store.set(trusting)
  const following: Following = {
    live,
    settings: makeSettingsStore(
      Schema.decodeUnknownSync(Settings)({ ...SETTINGS, instructionMode }),
    ),
    trusting: store,
    reloading: makeReloadingStore(),
    scriptFiles: NO_SCRIPT_FILES,
    act: () => Effect.succeed(undefined),
    trust: () => Effect.void,
    reload: () => Effect.void,
  }
  const document = Schema.decodeUnknownSync(DocumentView)({
    hash: HASH,
    tree: {
      type: "root",
      children: blocks.map((_, index) => ({ type: "block", index, children: [] })),
    },
    blocks: blocks.map((block, index) => ({ ...placed(block), index })),
    warnings: [],
  })
  return renderToStaticMarkup(
    <FollowingContext value={following}>
      <Runbook session={session} document={document} />
    </FollowingContext>,
  )
}

/** The items the prompt lists, as text. */
const listedIn = (markup: string): ReadonlyArray<string> => {
  const list = /<ul aria-label="What trusting it allows">(.*?)<\/ul>/.exec(markup)?.[1] ?? ""
  return [...list.matchAll(/<li>(.*?)<\/li>/g)].map(([, item]) =>
    (item ?? "")
      .replaceAll(/<[^>]+>/g, "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">"),
  )
}

describe("the trust prompt", () => {
  it("lists each block that declares an effect, each effect in plain words, while the session is untrusted", () => {
    const shown = page([NOTE, COMMAND, FORM, SIGN_IN, BROKEN])
    expect(shown).toContain('aria-label="Trust this runbook"')
    expect(shown).toContain("Make sure you trust this runbook")
    expect(shown).toContain("Until you trust this one, nothing in it runs.")
    expect(listedIn(shown)).toEqual([
      "<Shell> setup (Set up) may run commands and scripts on this computer.",
      "<CloudAuth> cloud may connect over the network and open your web browser.",
    ])
    expect(shown).toContain('<button type="button">I trust this runbook</button>')
  })

  it("puts every effect a block may declare in words", () => {
    const shown = page([
      {
        tag: "Shell",
        id: "setup",
        effects: ["process", "files", "repository", "network", "push", "browser"],
      },
    ])
    expect(listedIn(shown)).toEqual([
      "<Shell> setup may run commands and scripts on this computer, create and change files, clone and change git repositories, connect over the network, push changes to remote repositories and open your web browser.",
    ])
  })

  it("says no block declares an effect, when none does, and still offers trust for the forms", () => {
    const shown = page([FORM])
    expect(shown).toContain(
      "No block in it declares that it does anything to this computer or over the network.",
    )
    expect(shown).not.toContain("What trusting it allows")
    expect(shown).toContain(">I trust this runbook</button>")
  })

  // A runbook whose only lifecycle blocks are sign-ins could otherwise never be trusted, and they would wait forever.
  it.each([
    ["task", COMMAND, ["<Shell> setup (Set up) may run commands and scripts on this computer."]],
    ["form", FORM, []],
    [
      "credential",
      SIGN_IN,
      ["<CloudAuth> cloud may connect over the network and open your web browser."],
    ],
  ] as const)(
    "is shown when the only block that waits for trust is a %s block",
    (_, block, listed) => {
      const shown = page([NOTE, block])
      expect(shown).toContain('aria-label="Trust this runbook"')
      expect(listedIn(shown)).toEqual(listed)
    },
  )

  it("sits above the runbook's box, so nothing the author styles covers it", () => {
    const shown = page([COMMAND])
    const prompt = shown.indexOf('aria-label="Trust this runbook"')
    expect(prompt).toBeGreaterThan(-1)
    expect(prompt).toBeLessThan(shown.indexOf('class="runbook-body"'))
  })

  it.each([
    ["the session is trusted", [COMMAND], { trust: { trusted: true } }],
    ["instruction mode is on, where nothing runs", [COMMAND], { instructionMode: true }],
    [
      "the window stopped following the session",
      [COMMAND],
      { ended: "This runbook's session closed, so the window shows it as it was left." },
    ],
    ["no block waits for trust", [NOTE, BROKEN], {}],
  ] as const)("is not shown when %s", (_, blocks, shown) => {
    expect(page(blocks, shown)).not.toContain("Trust this runbook")
  })

  it("is not shown before the window has read the session's trust", () => {
    const shown = renderToStaticMarkup(
      <Runbook
        session={session}
        document={Schema.decodeUnknownSync(DocumentView)({
          hash: HASH,
          tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
          blocks: [placed(COMMAND)],
          warnings: [],
        })}
      />,
    )
    expect(shown).not.toContain("Trust this runbook")
  })

  it("says the runbook changed, and lists what it holds now in place of the page's blocks", () => {
    const shown = page([COMMAND], {
      trusting: {
        changed: {
          shown: Schema.decodeSync(TrustState.fields.hash)(HASH),
          hash: Schema.decodeSync(TrustState.fields.hash)(`sha256:${"2".repeat(64)}`),
          blocks: [placed({ tag: "Upload", id: "upload", effects: ["push"] })],
        },
      },
    })
    expect(shown).toContain(
      "This runbook changed since the window showed it, so nothing was trusted. This is what it holds now.",
    )
    expect(listedIn(shown)).toEqual(["<Upload> upload may push changes to remote repositories."])
  })

  it("lists the page's blocks, and says nothing changed, once the page draws another runbook than the one it asked over", () => {
    const shown = page([COMMAND], {
      trusting: {
        changed: {
          shown: Schema.decodeSync(TrustState.fields.hash)(`sha256:${"1".repeat(64)}`),
          hash: Schema.decodeSync(TrustState.fields.hash)(`sha256:${"2".repeat(64)}`),
          blocks: [placed({ tag: "Upload", id: "upload", effects: ["push"] })],
        },
      },
    })
    expect(shown).not.toContain("This runbook changed since the window showed it")
    expect(listedIn(shown)).toEqual([
      "<Shell> setup (Set up) may run commands and scripts on this computer.",
    ])
  })

  it("says why nothing was trusted when the ask failed", () => {
    const line =
      "The engine did not answer, so nothing was trusted: The engine bridge refused the message."
    expect(page([COMMAND], { trusting: { failed: line } })).toContain(
      `<p class="trust-failed">${line}</p>`,
    )
  })
})
