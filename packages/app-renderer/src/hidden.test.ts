import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { DocumentView, HIDDEN_LIMITS, SessionId, Settings } from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"
import { dies, fails, fakeMain } from "./fakeMain.ts"
import { followingOf } from "./following.ts"
import { askToHide, hiddenKeysIn, withHidden } from "./hidden.ts"
import { makeSettingsStore } from "./settings.ts"

// What the person asked a runbook's display blocks not to show again (the
// `hiddenInRunbooks` setting): the list as the window changes it, and the
// window asking the engine to keep it, against a main that answers
// `ChangeSettings` as a test says. Each value is the JSON main sends.

const A = "/runbooks/a/runbook.mdx"
const SESSION = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const B = "/runbooks/b/runbook.mdx"
const runbook = (n: number) => `/runbooks/r${n}/runbook.mdx`

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

/** The runbook a follower opened: hiding needs nothing from it. */
const OPENED = Schema.decodeUnknownSync(DocumentView)({
  hash: `sha256:${"0".repeat(64)}`,
  tree: { type: "root", children: [] },
  blocks: [],
  warnings: [],
})

describe("what a runbook's display blocks were hidden under", () => {
  it("is kept by runbook: the same key in another runbook is not hidden", () => {
    const hidden = withHidden([], A, "welcome")
    expect(hiddenKeysIn(hidden, A)).toEqual(["welcome"])
    expect(hiddenKeysIn(hidden, B)).toEqual([])
  })

  it("puts the runbook hidden in last first, and in it the key hidden last, each once", () => {
    let hidden = withHidden([], A, "welcome")
    hidden = withHidden(hidden, B, "welcome")
    hidden = withHidden(hidden, A, "billing")
    expect(hidden).toEqual([
      { runbook: A, keys: ["billing", "welcome"] },
      { runbook: B, keys: ["welcome"] },
    ])
  })

  it("gives back the list it was given for a key hidden already", () => {
    const hidden = withHidden(withHidden([], A, "welcome"), B, "billing")
    expect(withHidden(hidden, A, "welcome")).toBe(hidden)
  })

  it("forgets the runbook hidden in longest ago, and a runbook's oldest key, past the most it keeps", () => {
    let hidden = withHidden([], runbook(0), "first")
    for (let n = 1; n <= HIDDEN_LIMITS.runbooks; n++) hidden = withHidden(hidden, runbook(n), "k")
    expect(hidden).toHaveLength(HIDDEN_LIMITS.runbooks)
    expect(hiddenKeysIn(hidden, runbook(0))).toEqual([])
    expect(hidden[0]?.runbook).toBe(runbook(HIDDEN_LIMITS.runbooks))

    let keys = withHidden([], A, "k0")
    for (let k = 1; k <= HIDDEN_LIMITS.keys; k++) keys = withHidden(keys, A, `k${k}`)
    expect(hiddenKeysIn(keys, A)).toHaveLength(HIDDEN_LIMITS.keys)
    expect(hiddenKeysIn(keys, A)).not.toContain("k0")
    expect(hiddenKeysIn(keys, A)[0]).toBe(`k${HIDDEN_LIMITS.keys}`)
  })

  it("hides nothing the setting could not keep: a key too long, a path not absolute or too long", () => {
    const hidden = withHidden([], A, "welcome")
    expect(withHidden(hidden, A, "x".repeat(HIDDEN_LIMITS.keyLength + 1))).toBe(hidden)
    expect(withHidden(hidden, "runbooks/a/runbook.mdx", "welcome")).toBe(hidden)
    expect(withHidden(hidden, `/${"r".repeat(HIDDEN_LIMITS.runbookPath)}`, "welcome")).toBe(hidden)
  })
})

/** The settings with `payload`'s changes made, as main answers `ChangeSettings`. */
const changed = (payload: unknown) => {
  const { changes } = payload as { readonly changes: Partial<Settings> }
  return {
    _tag: "Changed",
    settings: { settings: { ...SETTINGS, ...changes }, file: "/data/settings.json", problems: [] },
  }
}

/** A main that answers `ChangeSettings` with `answer`, or, by default, the settings with the change made. */
const changingWith = (answer?: unknown) =>
  fakeMain((tag, payload) => {
    if (tag !== "ChangeSettings") return undefined
    return answer ?? changed(payload)
  })

/** Asks main to hide each of `hides` in turn, from `settings`, and gives what was sent and the settings the window keeps. */
const hiding = (
  main: ReturnType<typeof fakeMain>,
  hides: ReadonlyArray<readonly [string, string]>,
  settings: Settings | undefined,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* makeEngineClient(main.bridge)
        const store = makeSettingsStore(settings)
        for (const [file, key] of hides) yield* askToHide(engine, store, file, key)
        return {
          sent: main.asked.flatMap(({ tag, payload }) =>
            tag === "ChangeSettings" ? [payload] : [],
          ),
          kept: store.get(),
        }
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

describe("the window asking the engine to hide a key in a runbook", () => {
  it("sends the new list, and keeps the settings the engine answers with for the next hide", async () => {
    const { sent, kept } = await hiding(
      changingWith(),
      [
        [A, "welcome"],
        [B, "welcome"],
      ],
      SETTINGS,
    )
    expect(sent).toEqual([
      { changes: { hiddenInRunbooks: [{ runbook: A, keys: ["welcome"] }] } },
      {
        changes: {
          hiddenInRunbooks: [
            { runbook: B, keys: ["welcome"] },
            { runbook: A, keys: ["welcome"] },
          ],
        },
      },
    ])
    expect(kept?.hiddenInRunbooks).toEqual([
      { runbook: B, keys: ["welcome"] },
      { runbook: A, keys: ["welcome"] },
    ])
  })

  it("sends one hide at a time, so the second starts from the settings the first kept", async () => {
    let answerFirst = () => {}
    const main = fakeMain((tag, payload) => {
      if (tag !== "ChangeSettings") return undefined
      // The first change waits until the test answers it.
      if (main.asked.filter((asked) => asked.tag === "ChangeSettings").length > 1) {
        return changed(payload)
      }
      return new Promise((done) => {
        answerFirst = () => done(changed(payload))
      })
    })
    const changes = () =>
      main.asked.flatMap(({ tag, payload }) => (tag === "ChangeSettings" ? [payload] : []))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineClient(main.bridge)
          const following = followingOf(engine, Schema.decodeSync(SessionId)(SESSION), {
            document: OPENED,
            settings: SETTINGS,
          })
          const both = yield* Effect.forkChild(
            Effect.all([following.hide(A, "welcome"), following.hide(A, "billing")], {
              concurrency: "unbounded",
            }),
          )
          yield* Effect.sleep("50 millis")
          expect(changes()).toHaveLength(1)
          answerFirst()
          yield* Fiber.join(both)
        }),
      ).pipe(Effect.timeout("2 seconds")),
    )
    expect(changes()).toEqual([
      { changes: { hiddenInRunbooks: [{ runbook: A, keys: ["welcome"] }] } },
      { changes: { hiddenInRunbooks: [{ runbook: A, keys: ["billing", "welcome"] }] } },
    ])
  })

  it("asks nothing before the settings are read, nor for a key hidden already", async () => {
    expect((await hiding(changingWith(), [[A, "welcome"]], undefined)).sent).toEqual([])
    const hidden = Schema.decodeUnknownSync(Settings)({
      ...SETTINGS,
      hiddenInRunbooks: [{ runbook: A, keys: ["welcome"] }],
    })
    expect((await hiding(changingWith(), [[A, "welcome"]], hidden)).sent).toEqual([])
  })

  it.each([
    ["the file is read-only", { _tag: "ReadOnly", problem: { _tag: "Newer", version: 2 } }],
    [
      "it could not be saved",
      fails({ _tag: "SettingsNotSaved", file: "/data/settings.json", message: "Disk full." }),
    ],
    [
      "it takes this window for an agent",
      fails({ _tag: "Forbidden", command: "ChangeSettings", origin: "agent" }),
    ],
    ["the call dies", dies({ name: "Error", message: "the settings could not be written" })],
  ])("keeps the settings it has, and fails nothing, when %s", async (_, answer) => {
    const { sent, kept } = await hiding(changingWith(answer), [[A, "welcome"]], SETTINGS)
    expect(sent).toHaveLength(1)
    expect(kept).toBe(SETTINGS)
  })
})
