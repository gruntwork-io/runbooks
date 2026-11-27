import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { ask } from "./app.tsx"
import { type EngineBridge, makeEngineClient } from "./engine.ts"

// What the window shows, from what main answers over the bridge: each
// answer below is the JSON main sends.

/** A message the client sent, as main reads it. */
interface Sent {
  readonly _tag: string
  readonly id?: string
  readonly tag?: string
  readonly payload?: unknown
}

const SESSION = {
  session: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  name: "deep",
  path: "/runbooks/deep/runbook.mdx",
  blocks: 0,
}

/**
 * A bridge to a main that answers each command by its tag, on a later turn.
 * `asked` gets the payload of each `GetDocument` the client sends.
 */
const answering = (
  answers: Readonly<Record<string, (id: string) => unknown>>,
  asked: unknown[] = [],
): EngineBridge => {
  const listeners = new Set<(message: string) => void>()
  return {
    send: (text) => {
      const sent: Sent = JSON.parse(text)
      if (sent.tag === "GetDocument") asked.push(sent.payload)
      const answer = sent.tag === undefined ? undefined : answers[sent.tag]
      if (answer === undefined || sent.id === undefined) return
      const reply = JSON.stringify(answer(sent.id))
      setTimeout(() => {
        for (const listener of listeners) listener(reply)
      }, 0)
    },
    onMessage: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const shownWith = (bridge: EngineBridge) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeEngineClient(bridge), ask)).pipe(Effect.timeout("2 seconds")),
  )

describe("what the window shows", () => {
  it("says the engine failed when it fails getting the runbook's document, instead of asking forever", async () => {
    // As main answered a runbook 500 blockquotes deep (runbooks-reviewer on #650).
    const shown = await shownWith(
      answering({
        ListSessions: (requestId) => ({
          _tag: "Exit",
          requestId,
          exit: { _tag: "Success", value: [SESSION] },
        }),
        GetDocument: (requestId) => ({
          _tag: "Exit",
          requestId,
          exit: {
            _tag: "Failure",
            cause: [
              {
                _tag: "Die",
                defect: { name: "RangeError", message: "Maximum call stack size exceeded" },
              },
            ],
          },
        }),
      }),
    )
    expect(shown).toEqual({
      _tag: "Failed",
      message: "The engine failed showing the runbook: Maximum call stack size exceeded",
    })
  })

  it("is the runbook the engine opened last, when it has several open, with the settings", async () => {
    // As a second launch of the app leaves it: main opens its runbook, then reloads the page.
    const later = {
      ...SESSION,
      session: "9b2c1d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e",
      name: "later",
      path: "/runbooks/later/runbook.mdx",
    }
    const asked: unknown[] = []
    const shown = await shownWith(
      answering(
        {
          ListSessions: (requestId) => ({
            _tag: "Exit",
            requestId,
            exit: { _tag: "Success", value: [SESSION, later] },
          }),
          GetDocument: (requestId) => ({
            _tag: "Exit",
            requestId,
            exit: {
              _tag: "Success",
              value: {
                hash: `sha256:${"0".repeat(64)}`,
                tree: { type: "root", children: [] },
                blocks: [],
                warnings: [],
              },
            },
          }),
          GetSettings: (requestId) => ({
            _tag: "Exit",
            requestId,
            exit: {
              _tag: "Success",
              value: {
                settings: {
                  theme: "system",
                  instructionMode: true,
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
                },
                file: "/data/settings.json",
                problems: [],
              },
            },
          }),
        },
        asked,
      ),
    )
    expect(shown).toMatchObject({
      _tag: "Runbook",
      session: { session: later.session, path: later.path },
      settings: { instructionMode: true },
    })
    expect(asked).toEqual([{ session: later.session }])
  })

  it("is the welcome screen when the engine has no runbook open", async () => {
    const shown = await shownWith(
      answering({
        ListSessions: (requestId) => ({
          _tag: "Exit",
          requestId,
          exit: { _tag: "Success", value: [] },
        }),
      }),
    )
    expect(shown).toEqual({ _tag: "Welcome" })
  })
})
