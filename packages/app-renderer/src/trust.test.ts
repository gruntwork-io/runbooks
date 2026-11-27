import { describe, expect, it } from "bun:test"
import { Effect, Queue, Schema } from "effect"
import { DocumentView, SessionId, Settings } from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"
import { dies, type FakeMain, fails, fakeMain } from "./fakeMain.ts"
import { followingOf } from "./following.ts"
import type { Trusting } from "./trust.ts"

// The window asking the engine to trust the session it follows, against a
// main that answers `GetSession` with an untrusted session and every other
// command as a test says. Each value is the JSON main sends.

const SESSION = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const SHOWN = `sha256:${"1".repeat(64)}`
const NOW = `sha256:${"2".repeat(64)}`
const LATER = `sha256:${"3".repeat(64)}`

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
})

/** The runbook the window opened, whose hash is SHOWN. */
const OPENED = Schema.decodeUnknownSync(DocumentView)({
  hash: SHOWN,
  tree: { type: "root", children: [] },
  blocks: [],
  warnings: [],
})

/** A block the runbook holds once it changed, as `GetDocument` gives it. */
const ADDED = {
  _tag: "Configured",
  index: 0,
  tag: "Example",
  block: "Example",
  class: "task",
  id: "upload",
  span: { start: { line: 3, column: 1 }, end: { line: 3, column: 30 } },
  step: true,
  effects: ["network"],
}

/** A main whose session is untrusted for SHOWN, and which answers the rest with `answer`. */
const untrusted = (answer: (tag: string, payload: unknown) => unknown) =>
  fakeMain((tag, payload) =>
    tag === "GetSession"
      ? {
          session: SESSION,
          name: "deploy",
          path: "/runbooks/deploy/runbook.mdx",
          trust: { trusted: false, hash: SHOWN },
          blocks: [],
          warnings: [],
        }
      : answer(tag, payload),
  )

/** The runbook as `GetDocument` gives it with `hash`, holding `blocks`. */
const held = (hash: string, blocks: ReadonlyArray<unknown> = []) => ({
  hash,
  tree: { type: "root", children: [] },
  blocks,
  warnings: [],
})

let sequence = 0
/** The session reloading its runbook, untrusted, for `hash`: its events, as the engine logs them. */
const reloadedTo = (hash: string) =>
  [
    { _tag: "DocumentChanged", hash },
    { _tag: "TrustChanged", trust: { trusted: false, hash } },
  ].map((event) => ({
    session: SESSION,
    sequence: ++sequence,
    at: "2026-11-26T12:00:00.000Z",
    event,
  }))

/**
 * Follows the session `main` serves, and runs `body` once the window has
 * read it, with the window and a queue that gets each change it shows.
 */
const followed = <A>(
  main: FakeMain,
  body: (following: ReturnType<typeof followingOf>, changes: Queue.Queue<void>) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* makeEngineClient(main.bridge)
        const following = followingOf(engine, Schema.decodeSync(SessionId)(SESSION), {
          document: OPENED,
          settings: SETTINGS,
        })
        const changes = yield* Queue.unbounded<void>()
        following.live.subscribe(() => Queue.offerUnsafe(changes, undefined))
        yield* Effect.acquireRelease(Effect.sync(following.start), (stop) => Effect.sync(stop))
        yield* Queue.take(changes)
        return yield* body(following, changes)
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

/** The payload of each `TrustSession` the window sent `main`. */
const sentTo = (main: FakeMain) =>
  main.asked.flatMap(({ tag, payload }) => (tag === "TrustSession" ? [payload] : []))

/**
 * Follows the session `main` serves, asks to trust it `asks` times in turn,
 * and gives what the window kept after each ask, and the hash each
 * `TrustSession` sent.
 */
const asking = (main: FakeMain, asks = 1) =>
  followed(main, (following) =>
    Effect.gen(function* () {
      const kept: Trusting[] = []
      for (let ask = 0; ask < asks; ask++) {
        yield* following.trust()
        kept.push(following.trusting.get())
      }
      return { kept, sent: sentTo(main) }
    }),
  )

describe("the window asking the engine to trust the session", () => {
  it("sends the hash of the session it was shown, and keeps nothing once it is trusted", async () => {
    const { kept, sent } = await asking(
      untrusted((tag) => (tag === "TrustSession" ? { _tag: "Trusted" } : undefined)),
    )
    expect(sent).toEqual([{ session: SESSION, hash: SHOWN }])
    expect(kept).toEqual([{}])
  })

  it.each([
    [
      "the session is gone",
      fails({ _tag: "UnknownSession", session: SESSION }),
      "This runbook's session closed, so nothing was trusted.",
    ],
    [
      "it takes this window for an agent",
      fails({ _tag: "Forbidden", command: "TrustSession", origin: "agent" }),
      "The engine doesn't take trust from this window, so nothing was trusted.",
    ],
    [
      "the call dies",
      dies({ name: "Error", message: "the hash could not be read" }),
      "The engine failed, so nothing was trusted: the hash could not be read",
    ],
  ])("says nothing was trusted, and why, when %s", async (_, answer, line) => {
    const { kept } = await asking(untrusted((tag) => (tag === "TrustSession" ? answer : undefined)))
    expect(kept).toEqual([{ failed: line }])
  })

  it("keeps what the runbook holds now when it changed, and trusts that the next time", async () => {
    let answers = 0
    const { kept, sent } = await asking(
      untrusted((tag) => {
        switch (tag) {
          case "TrustSession":
            return answers++ === 0 ? { _tag: "HashChanged", current: NOW } : { _tag: "Trusted" }
          case "GetDocument":
            return {
              hash: NOW,
              tree: { type: "root", children: [] },
              blocks: [ADDED],
              warnings: [],
            }
          default:
            return undefined
        }
      }),
      2,
    )
    expect(sent).toEqual([
      { session: SESSION, hash: SHOWN },
      { session: SESSION, hash: NOW },
    ])
    expect<unknown>(kept[0]?.changed?.hash).toBe(NOW)
    expect<unknown>(kept[0]?.changed?.blocks.map((block) => block.id)).toEqual(["upload"])
    expect(kept[0]?.failed).toBeUndefined()
    expect(kept[1]).toEqual({})
  })

  it("trusts what the runbook holds now when it changed twice while the page still draws the runbook it opened", async () => {
    const answers = [
      { _tag: "HashChanged", current: NOW },
      { _tag: "HashChanged", current: LATER },
      { _tag: "Trusted" },
    ]
    let asked = 0
    const { kept, sent } = await asking(
      untrusted((tag) =>
        tag === "TrustSession"
          ? answers[asked++]
          : tag === "GetDocument"
            ? held(asked === 1 ? NOW : LATER, [ADDED])
            : undefined,
      ),
      3,
    )
    expect(sent.map((payload) => (payload as { hash: string }).hash)).toEqual([SHOWN, NOW, LATER])
    expect<unknown>(kept[1]?.changed?.hash).toBe(LATER)
    expect(kept[2]).toEqual({})
  })

  it("keeps what the runbook holds now, to trust it, when a later ask fails", async () => {
    let answers = 0
    const { kept, sent } = await asking(
      untrusted((tag) => {
        switch (tag) {
          case "TrustSession":
            return answers++ === 0
              ? { _tag: "HashChanged", current: NOW }
              : fails({ _tag: "UnknownSession", session: SESSION })
          case "GetDocument":
            return {
              hash: NOW,
              tree: { type: "root", children: [] },
              blocks: [ADDED],
              warnings: [],
            }
          default:
            return undefined
        }
      }),
      3,
    )
    expect(sent.map((payload) => (payload as { hash: string }).hash)).toEqual([SHOWN, NOW, NOW])
    expect<unknown>(kept[1]?.changed?.hash).toBe(NOW)
    expect(kept[1]?.failed).toBe("This runbook's session closed, so nothing was trusted.")
  })

  it("sends the hash of the runbook the page draws once the session reloaded it, not the trust's", async () => {
    // A second reload was taken before the window read the runbook the first one gave.
    const main = untrusted((tag) =>
      tag === "GetDocument"
        ? held(LATER)
        : tag === "TrustSession"
          ? { _tag: "Trusted" }
          : undefined,
    )
    const sent = await followed(main, (following, changes) =>
      Effect.gen(function* () {
        main.stream("Events", reloadedTo(NOW))
        yield* Queue.take(changes)
        expect<unknown>(following.live.get().trust?.hash).toBe(NOW)
        yield* following.trust()
        return sentTo(main)
      }),
    )
    expect(sent).toEqual([{ session: SESSION, hash: LATER }])
  })

  it("trusts the runbook the page draws once it redrew, not what the engine said the runbook held before", async () => {
    let reloaded = false
    const main = untrusted((tag) => {
      switch (tag) {
        case "TrustSession":
          return reloaded ? { _tag: "Trusted" } : { _tag: "HashChanged", current: NOW }
        case "GetDocument":
          return reloaded ? held(LATER) : held(NOW, [ADDED])
        default:
          return undefined
      }
    })
    const { kept, sent } = await followed(main, (following, changes) =>
      Effect.gen(function* () {
        yield* following.trust()
        const changed = following.trusting.get()
        reloaded = true
        main.stream("Events", reloadedTo(LATER))
        yield* Queue.take(changes)
        yield* following.trust()
        return { kept: [changed, following.trusting.get()], sent: sentTo(main) }
      }),
    )
    expect(sent.map((payload) => (payload as { hash: string }).hash)).toEqual([SHOWN, LATER])
    expect<unknown>(kept[0]?.changed?.hash).toBe(NOW)
    expect(kept[1]).toEqual({})
  })

  it("asks nothing before the window has read the session", async () => {
    const main = untrusted(() => ({ _tag: "Trusted" }))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineClient(main.bridge)
          yield* followingOf(engine, Schema.decodeSync(SessionId)(SESSION), {
            document: OPENED,
            settings: SETTINGS,
          }).trust()
        }),
      ).pipe(Effect.timeout("2 seconds")),
    )
    expect(sentTo(main)).toEqual([])
  })

  it("says nothing was trusted when the runbook changed and what it holds now can't be read", async () => {
    const { kept } = await asking(
      untrusted((tag) =>
        tag === "TrustSession"
          ? { _tag: "HashChanged", current: NOW }
          : tag === "GetDocument"
            ? dies({ name: "RangeError", message: "Maximum call stack size exceeded" })
            : undefined,
      ),
    )
    expect(kept).toEqual([
      { failed: "The engine failed, so nothing was trusted: Maximum call stack size exceeded" },
    ])
  })

  it("says nothing was trusted when the bridge refuses the ask", async () => {
    const main = untrusted(() => undefined)
    const refusing: FakeMain = {
      ...main,
      bridge: {
        ...main.bridge,
        send: (text) => {
          if (text.includes('"tag":"TrustSession"')) throw new Error("over the bridge's cap")
          main.bridge.send(text)
        },
      },
    }
    const { kept } = await asking(refusing)
    expect(kept).toEqual([
      {
        failed:
          "The engine did not answer, so nothing was trusted: The engine bridge refused the message.",
      },
    ])
  })
})
