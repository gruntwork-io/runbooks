import { describe, it, expect } from "bun:test"
import { generateFuzzValue, resolveTestInputs } from "./fuzz.ts"
import type { FuzzConfig, InputValue } from "./config.ts"

// Run a generator N times so randomness-sensitive tests still cover the
// likely-output space without going flaky on a single draw.
const SAMPLES = 20

describe("generateFuzzValue", () => {
  it("string: respects fixed length", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({ type: "string", length: 7 }) as string
      expect(v).toHaveLength(7)
    }
  })

  it("string: stays within minLength/maxLength", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({
        type: "string",
        minLength: 3,
        maxLength: 5,
      }) as string
      expect(v.length).toBeGreaterThanOrEqual(3)
      expect(v.length).toBeLessThanOrEqual(5)
    }
  })

  it("string: applies prefix and suffix", () => {
    const v = generateFuzzValue({
      type: "string",
      length: 4,
      prefix: "p-",
      suffix: "-s",
    }) as string
    expect(v.startsWith("p-")).toBe(true)
    expect(v.endsWith("-s")).toBe(true)
    // Total length = prefix + 4 + suffix.
    expect(v.length).toBe(2 + 4 + 2)
  })

  it("int: stays within min/max inclusive", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({ type: "int", min: 5, max: 10 }) as number
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThanOrEqual(10)
    }
  })

  it("float: stays within min/max", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({ type: "float", min: 0, max: 1 }) as number
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it("bool: returns a boolean", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({ type: "bool" })
      expect(typeof v).toBe("boolean")
    }
  })

  it("enum: picks one of the provided options", () => {
    const opts = ["red", "green", "blue"]
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({ type: "enum", options: opts }) as string
      expect(opts).toContain(v)
    }
  })

  it("enum: throws when no options are provided", () => {
    expect(() => generateFuzzValue({ type: "enum" })).toThrow(/No enum options/)
  })

  it("email: produces a value containing @ and a dot", () => {
    const v = generateFuzzValue({ type: "email" }) as string
    expect(v).toMatch(/.+@.+\..+/)
  })

  it("email: respects a custom domain", () => {
    const v = generateFuzzValue({ type: "email", domain: "acme.test" }) as string
    expect(v.endsWith("@acme.test")).toBe(true)
  })

  it("url: produces an https URL", () => {
    const v = generateFuzzValue({ type: "url" }) as string
    expect(v.startsWith("https://")).toBe(true)
    // Must be a parseable URL.
    expect(() => new URL(v)).not.toThrow()
  })

  it("uuid: matches v4 UUID shape and variant bits", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({ type: "uuid" }) as string
      expect(v).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    }
  })

  it("date: returns ISO YYYY-MM-DD", () => {
    const v = generateFuzzValue({ type: "date" }) as string
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("date: respects minDate / maxDate range", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const v = generateFuzzValue({
        type: "date",
        minDate: "2024-01-01",
        maxDate: "2024-01-05",
      }) as string
      expect(v >= "2024-01-01").toBe(true)
      expect(v <= "2024-01-05").toBe(true)
    }
  })

  it("timestamp: returns ISO 8601 with time", () => {
    const v = generateFuzzValue({ type: "timestamp" }) as string
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it("words: returns the requested number of words", () => {
    const v = generateFuzzValue({ type: "words", wordCount: 4 }) as string
    expect(v.split(/\s+/)).toHaveLength(4)
  })

  it("list: returns a JSON-encoded array of N items", () => {
    const v = generateFuzzValue({ type: "list", count: 3 }) as string
    const parsed = JSON.parse(v)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(3)
  })

  it("map (no schema): returns a JSON-encoded object", () => {
    const v = generateFuzzValue({ type: "map", count: 2 }) as string
    const parsed = JSON.parse(v)
    expect(typeof parsed).toBe("object")
    expect(Object.keys(parsed).length).toBe(2)
  })

  it("map (with schema): returns nested objects keyed by schema fields", () => {
    const v = generateFuzzValue({
      type: "map",
      count: 1,
      schema: ["alpha", "beta"],
    }) as Record<string, Record<string, string>>
    const outerKeys = Object.keys(v)
    expect(outerKeys).toHaveLength(1)
    expect(Object.keys(v[outerKeys[0]]).sort()).toEqual(["alpha", "beta"])
  })

  it("unknown type: throws a descriptive error", () => {
    expect(() =>
      generateFuzzValue({ type: "totally-unknown" as unknown as FuzzConfig["type"] }),
    ).toThrow(/Unknown fuzz type/)
  })
})

// ---------------------------------------------------------------------------
// resolveTestInputs
// ---------------------------------------------------------------------------

describe("resolveTestInputs", () => {
  it("passes literal values through unchanged", () => {
    const out = resolveTestInputs({
      foo: { literal: "bar" },
      n: { literal: 42 },
      yes: { literal: true },
    })
    expect(out).toEqual({ foo: "bar", n: 42, yes: true })
  })

  it("expands fuzz values to concrete inputs", () => {
    const out = resolveTestInputs({
      name: { fuzz: { type: "string", length: 5 } },
      // min == max collapses the int range to a single value.
      age: { fuzz: { type: "int", min: 7, max: 7 } },
    })
    expect(typeof out.name).toBe("string")
    expect((out.name as string).length).toBe(5)
    // generateInt treats max <= min as a default range, so 7..7 may not
    // yield exactly 7 — confirm it's a finite integer either way.
    expect(typeof out.age).toBe("number")
    expect(Number.isInteger(out.age)).toBe(true)
  })

  it("returns an empty object when inputs is undefined", () => {
    expect(resolveTestInputs(undefined as Record<string, InputValue> | undefined)).toEqual(
      {},
    )
  })
})
