import { describe, expect, it } from "bun:test"
import { Cause, Exit, Schema } from "effect"
import { FieldValue, MAX_VALUE_DEPTH } from "./form.ts"

/** `leaf` inside `depth` lists, or maps when `inMaps`. */
function nested(depth: number, leaf: FieldValue = "x", inMaps = false): FieldValue {
  let value = leaf
  for (let level = 0; level < depth; level++) value = inMaps ? { k: value } : [value]
  return value
}

const decode = Schema.decodeUnknownExit(FieldValue)

/** The decode's error message, or why there is none: it decoded, or it died. */
function refusal(exit: Exit.Exit<unknown, Schema.SchemaError>): string {
  if (Exit.isSuccess(exit)) return "decoded"
  if (Cause.hasDies(exit.cause)) return `died: ${String(Cause.squash(exit.cause))}`
  return String(Cause.squash(exit.cause))
}

describe("FieldValue", () => {
  it("takes lists and maps nested as deep as MAX_VALUE_DEPTH, and a form's own values", () => {
    expect(MAX_VALUE_DEPTH).toBe(32)
    for (const inMaps of [false, true]) {
      const value = nested(MAX_VALUE_DEPTH, 1, inMaps)
      expect(Schema.decodeUnknownSync(FieldValue)(value)).toEqual(value)
    }
    const entries = { dev: { email: "dev@example.com", id: "111" }, tags: ["a", true, 2] }
    expect(Schema.decodeUnknownSync(FieldValue)(entries)).toEqual(entries)
  })

  it("refuses one level more, in a list or a map, quoting none of the value", () => {
    for (const inMaps of [false, true]) {
      const message = refusal(decode(nested(MAX_VALUE_DEPTH + 1, "fake-secret-d33p", inMaps)))
      expect(message).toContain(`Expected a value nested at most ${MAX_VALUE_DEPTH} levels deep`)
      expect(message).not.toContain("fake-secret-d33p")
    }
  })

  it("refuses a value nested 10,000 deep as a schema error, not a defect, naming where it is", () => {
    const Values = Schema.toCodecJson(Schema.Record(Schema.String, FieldValue))
    const message = refusal(Schema.decodeUnknownExit(Values)({ token: nested(10_000) }))
    expect(message).toContain(`Expected a value nested at most ${MAX_VALUE_DEPTH} levels deep`)
    expect(message).toContain('at ["token"]')
  })

  it("checks a value's shape as before, once its depth is in bounds", () => {
    for (const value of [null, [1, null], { a: undefined }])
      expect(refusal(decode(value))).toContain(
        "Expected string | number | boolean | array | object",
      )
  })
})
