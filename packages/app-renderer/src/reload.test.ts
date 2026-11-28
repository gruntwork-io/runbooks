import { describe, expect, it } from "bun:test"
import { Effect, Queue, Schema } from "effect"
import { BlockView, DocumentView, FilesOnDisk, SessionId, Settings } from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"
import { dies, type FakeMain, fails, fakeMain } from "./fakeMain.ts"
import { followingOf } from "./following.ts"
import type { Reloading } from "./reload.ts"

// The window asking the engine to reload a block's files, as the "Script
// changed" notice's button does, against a main that answers `GetSession`
// with a trusted session and `ReloadFiles` as a test says. Each value is
// the JSON main sends.

const SESSION = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const DRAWN = `sha256:${"1".repeat(64)}`
const GREET = Schema.decodeSync(BlockView.fields.block)("greet")

/** The hash of the files `greet` shows on disk, as the engine sends it. */
const ON_DISK = Schema.decodeUnknownSync(FilesOnDisk)({
  hash: `sha256:${"5".repeat(64)}`,
  files: [{ _tag: "Unreadable", path: "greet.sh", reason: "greet.sh can't be read." }],
}).hash

const SETTINGS = Schema.decodeUnknownSync(Settings)({
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
})

/** The runbook the window opened, whose hash is DRAWN. */
const OPENED = Schema.decodeUnknownSync(DocumentView)({
  hash: DRAWN,
  tree: { type: "root", children: [] },
  blocks: [],
  warnings: [],
})

/** A main whose session is trusted for DRAWN, and which answers `ReloadFiles` with `answer`. */
const reloadingWith = (answer: unknown) =>
  fakeMain((tag) => {
    switch (tag) {
      case "GetSession":
        return {
          session: SESSION,
          name: "deploy",
          path: "/runbooks/deploy/runbook.mdx",
          trust: { trusted: true, hash: DRAWN },
          blocks: [],
          warnings: [],
        }
      case "ReloadFiles":
        return answer
      default:
        return undefined
    }
  })

/**
 * Follows the session `main` serves, asks once it has read it to reload
 * the files of `greet`, then of each of `others`, at ON_DISK, and gives
 * what the window kept of `greet` after each change, what it keeps of each
 * block at the end, the page it drew, and each `ReloadFiles` it sent.
 */
const reloading = (main: FakeMain, others: ReadonlyArray<typeof GREET> = []) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* makeEngineClient(main.bridge)
        const following = followingOf(engine, Schema.decodeSync(SessionId)(SESSION), {
          document: OPENED,
          settings: SETTINGS,
        })
        const read = yield* Queue.unbounded<void>()
        following.live.subscribe(() => Queue.offerUnsafe(read, undefined))
        yield* Effect.acquireRelease(Effect.sync(following.start), (stop) => Effect.sync(stop))
        yield* Queue.take(read)
        const kept: Array<Reloading | undefined> = []
        following.reloading.subscribe(() => kept.push(following.reloading.get().get(GREET)))
        for (const block of [GREET, ...others]) yield* following.reload(block, ON_DISK)
        return {
          kept,
          last: following.reloading.get(),
          drawn: following.live.get().document,
          sent: main.asked.flatMap(({ tag, payload }) => (tag === "ReloadFiles" ? [payload] : [])),
        }
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

describe("the window asking the engine to reload a block's files", () => {
  it("sends the hash of the files the block shows, as the person, and keeps the answer for them on the page it drew", async () => {
    const { kept, drawn, sent } = await reloading(
      reloadingWith({ _tag: "Running", blocks: ["deploy"] }),
    )
    expect(sent).toEqual([{ session: SESSION, block: "greet", hash: ON_DISK }])
    expect<unknown>(kept).toEqual([
      { hash: ON_DISK, drawn, answer: { _tag: "Asking" } },
      { hash: ON_DISK, drawn, answer: { _tag: "Running", blocks: ["deploy"] } },
    ])
    expect(drawn).toBe(OPENED)
  })

  it("keeps what came of the last ask for each block", async () => {
    const deploy = Schema.decodeSync(BlockView.fields.block)("deploy")
    const { last, drawn } = await reloading(reloadingWith({ _tag: "NotShown" }), [deploy])
    expect<unknown>(last).toEqual(
      new Map([
        [GREET, { hash: ON_DISK, drawn, answer: { _tag: "NotShown" } }],
        [deploy, { hash: ON_DISK, drawn, answer: { _tag: "NotShown" } }],
      ]),
    )
  })

  it.each([
    ["it took them", { _tag: "Reloaded" }],
    ["the files changed again", { _tag: "NotShown" }],
  ])("keeps what the engine said when %s", async (_, answer) => {
    const { kept } = await reloading(reloadingWith(answer))
    expect<unknown>(kept.map((reloaded) => reloaded?.answer)).toEqual([{ _tag: "Asking" }, answer])
  })

  it.each([
    [
      "the session is gone",
      fails({ _tag: "UnknownSession", session: SESSION }),
      "This runbook's session closed, so nothing was reloaded.",
    ],
    [
      "the engine has no such block",
      fails({ _tag: "UnknownBlock", session: SESSION, block: "greet" }),
      "The engine has no block greet in this runbook's session, so nothing was reloaded.",
    ],
    [
      "it takes this window for an agent",
      fails({ _tag: "Forbidden", command: "ReloadFiles", origin: "agent" }),
      "The engine doesn't take reloads from this window, so nothing was reloaded.",
    ],
    [
      "the call dies",
      dies({ name: "Error", message: "the files could not be parsed" }),
      "The engine failed, so nothing was reloaded: the files could not be parsed",
    ],
  ])("says nothing was reloaded, and why, when %s", async (_, answer, line) => {
    const { kept } = await reloading(reloadingWith(answer))
    expect<unknown>(kept.map((reloaded) => reloaded?.answer)).toEqual([
      { _tag: "Asking" },
      { _tag: "Failed", line },
    ])
  })
})
