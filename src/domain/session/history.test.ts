import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  SESSION_EVENT_BLOCK_ID_MAX_LENGTH,
  SESSION_EVENT_PAYLOAD_MAX_LENGTH,
  parseSessionEvent,
  replacesPreviousEvent,
} from "./history.ts"

const parse = (request: Parameters<typeof parseSessionEvent>[0]) =>
  Effect.runSync(Effect.either(parseSessionEvent(request)))

/** The message parseSessionEvent refuses `request` with. */
function refusal(request: Parameters<typeof parseSessionEvent>[0]): string {
  const result = parse(request)
  if (result._tag === "Right") throw new Error("the event was accepted")
  expect(result.left._tag).toBe("SessionEventError")
  return result.left.message
}

describe("parseSessionEvent", () => {
  it("returns the event with its payload as JSON", () => {
    const result = parse({
      blockId: "config",
      kind: "inputs",
      payload: { values: { region: "us-east-1", count: 2, tags: ["a"] }, submitted: true },
    })

    expect(result).toMatchObject({
      _tag: "Right",
      right: {
        blockId: "config",
        kind: "inputs",
        payload: '{"values":{"region":"us-east-1","count":2,"tags":["a"]},"submitted":true}',
      },
    })
  })

  it("refuses an event without a block id, or with one that is too long", () => {
    expect(refusal({ blockId: "", kind: "run", payload: {} })).toContain("the id of its block")
    expect(refusal({ blockId: 7, kind: "run", payload: {} })).toContain("the id of its block")

    const longest = "b".repeat(SESSION_EVENT_BLOCK_ID_MAX_LENGTH)
    expect(parse({ blockId: longest, kind: "run", payload: {} })._tag).toBe("Right")
    expect(refusal({ blockId: `${longest}b`, kind: "run", payload: {} })).toContain(
      `at most ${SESSION_EVENT_BLOCK_ID_MAX_LENGTH} characters`,
    )
  })

  it("refuses a kind that is not one, and names the ones that are", () => {
    for (const kind of ["outputs", "", undefined, "__proto__"]) {
      expect(refusal({ blockId: "config", kind, payload: {} })).toContain(
        "must be one of inputs, run, render, clone, pull-request, auth",
      )
    }
  })

  it("refuses a payload that has no JSON form", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const payload of [undefined, () => {}, cyclic, { big: 1n }]) {
      expect(refusal({ blockId: "deploy", kind: "run", payload })).toBe(
        'the run event of block "deploy" has a payload that is not JSON',
      )
    }
  })

  it("refuses a payload longer than the limit, without repeating it", () => {
    // A JSON string is its characters and two quotes.
    const fits = "x".repeat(SESSION_EVENT_PAYLOAD_MAX_LENGTH - 2)
    expect(parse({ blockId: "deploy", kind: "run", payload: fits })._tag).toBe("Right")

    const message = refusal({ blockId: "deploy", kind: "run", payload: `${fits}x` })
    expect(message).toContain(`${SESSION_EVENT_PAYLOAD_MAX_LENGTH + 1} characters of JSON`)
    expect(message).not.toContain("xxx")
  })
})

describe("replacesPreviousEvent", () => {
  it("is true for a form's values and a template's files, and false for the other kinds", () => {
    expect(replacesPreviousEvent("inputs")).toBe(true)
    expect(replacesPreviousEvent("render")).toBe(true)
    for (const kind of ["run", "clone", "pull-request", "auth"] as const) {
      expect(replacesPreviousEvent(kind)).toBe(false)
    }
  })
})
