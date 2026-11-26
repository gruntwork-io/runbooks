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
}

const SESSION = {
  session: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  name: "deep",
  path: "/runbooks/deep/runbook.mdx",
  blocks: 0,
}

/** A bridge to a main that answers each command by its tag, on a later turn. */
const answering = (answers: Readonly<Record<string, (id: string) => unknown>>): EngineBridge => {
  const listeners = new Set<(message: string) => void>()
  return {
    send: (text) => {
      const sent: Sent = JSON.parse(text)
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
