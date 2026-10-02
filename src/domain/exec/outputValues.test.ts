import { describe, it, expect } from "bun:test"
import { inspect } from "node:util"
import {
  decodeOutputs,
  encodeOutputs,
  isSensitiveOutput,
  maskOutput,
  maskOutputs,
  revealOutput,
  revealOutputs,
  sensitiveOutput,
  type OutputValues,
} from "./outputValues.ts"

const SECRET = "s3cr3t-value"

const outputs: OutputValues = { user: "alice", token: sensitiveOutput(SECRET) }

describe("a sensitive output", () => {
  // Every way a consumer might print or serialize the outputs, without
  // knowing any of them is sensitive
  it("never shows its value when the outputs are printed or serialized", () => {
    expect(String(outputs.token)).toBe("<redacted>")
    expect(`${outputs.token}`).toBe("<redacted>")
    expect(JSON.stringify(outputs)).toBe('{"user":"alice","token":"<redacted>"}')
    expect(inspect(outputs)).not.toContain(SECRET)
    expect(inspect(outputs)).toContain("<redacted>")
  })

  it("loses its value, not leaks it, when structured-cloned like an IPC payload", () => {
    const cloned = structuredClone(outputs) as Record<string, unknown>
    expect(cloned.token).toEqual({})
    expect(JSON.stringify(cloned)).not.toContain(SECRET)
  })

  it("is read only through revealOutput", () => {
    expect(isSensitiveOutput(outputs.token!)).toBe(true)
    expect(revealOutput(outputs.token)).toBe(SECRET)
    expect(revealOutputs(outputs)).toEqual({ user: "alice", token: SECRET })
  })

  it("shows as <redacted> through maskOutput", () => {
    expect(maskOutput(outputs.token!)).toBe("<redacted>")
    expect(maskOutputs(outputs)).toEqual({ user: "alice", token: "<redacted>" })
  })

  // An empty value reveals nothing, and a masked `{{ if }}` then takes the same branch as the real one
  it("shows as empty through maskOutput when its value is empty", () => {
    const empty = sensitiveOutput("")
    expect(isSensitiveOutput(empty)).toBe(true)
    expect(maskOutput(empty)).toBe("")
  })
})

describe("a plain output", () => {
  it("passes through reveal and mask unchanged", () => {
    expect(isSensitiveOutput(outputs.user!)).toBe(false)
    expect(revealOutput(outputs.user)).toBe("alice")
    expect(maskOutput(outputs.user!)).toBe("alice")
  })
})

describe("revealOutput", () => {
  it("passes a missing output through", () => {
    expect(revealOutput(undefined)).toBeUndefined()
  })
})

describe("IPC encoding", () => {
  it("sends each output's real value and whether it's sensitive", () => {
    expect(encodeOutputs(outputs)).toEqual({
      user: { value: "alice", sensitive: false },
      token: { value: SECRET, sensitive: true },
    })
  })

  it("round-trips through structured clone, wrapping the sensitive values again", () => {
    const received = decodeOutputs(structuredClone(encodeOutputs(outputs)))

    expect(received.user).toBe("alice")
    expect(isSensitiveOutput(received.token!)).toBe(true)
    expect(revealOutput(received.token)).toBe(SECRET)
    expect(JSON.stringify(received)).not.toContain(SECRET)
  })
})
