import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Either } from "effect"
import { RenderError } from "../errors/index.ts"
import { resolveBoilerplateBinary } from "./WasmBoilerplate.ts"

// The main process always points BOILERPLATE_BIN at the vendored copy before
// any render. An unset var is a wiring bug and must fail — never fall back to
// a `boilerplate` on PATH, which could be any version.
describe("resolveBoilerplateBinary", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.BOILERPLATE_BIN
  })

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.BOILERPLATE_BIN
    } else {
      process.env.BOILERPLATE_BIN = saved
    }
  })

  it("returns BOILERPLATE_BIN when set", async () => {
    process.env.BOILERPLATE_BIN = "/app/resources/bin/boilerplate"
    const bin = await Effect.runPromise(resolveBoilerplateBinary())
    expect(bin).toBe("/app/resources/bin/boilerplate")
  })

  it("fails with RenderError instead of falling back to PATH when unset", async () => {
    delete process.env.BOILERPLATE_BIN
    const result = await Effect.runPromise(Effect.either(resolveBoilerplateBinary()))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RenderError)
      expect(result.left.message).toContain("BOILERPLATE_BIN is not set")
    }
  })

  it("treats an empty BOILERPLATE_BIN as unset", async () => {
    process.env.BOILERPLATE_BIN = ""
    const result = await Effect.runPromise(Effect.either(resolveBoilerplateBinary()))
    expect(Either.isLeft(result)).toBe(true)
  })
})
