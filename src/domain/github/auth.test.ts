import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { detectTokenType, detectEnvCredentials, detectCliCredentials } from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestSpawner } from "../../test-utils/TestSpawner.ts"
import { Layer } from "effect"

describe("detectTokenType", () => {
  it("identifies classic PAT", () => {
    expect(detectTokenType("ghp_abc123")).toBe("classic_pat")
  })

  it("identifies fine-grained PAT", () => {
    expect(detectTokenType("github_pat_abc123")).toBe("fine_grained_pat")
  })

  it("identifies OAuth token", () => {
    expect(detectTokenType("gho_abc123")).toBe("oauth")
  })

  it("identifies GitHub App token", () => {
    expect(detectTokenType("ghs_abc123")).toBe("github_app")
  })

  it("returns unknown for unrecognized prefix", () => {
    expect(detectTokenType("random_token")).toBe("unknown")
  })

  it("returns unknown for empty string", () => {
    expect(detectTokenType("")).toBe("unknown")
  })
})

describe("detectEnvCredentials", () => {
  it("returns GITHUB_TOKEN when set", async () => {
    const layer = makeTestEnvironment({ GITHUB_TOKEN: "ghp_test123" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("ghp_test123")
  })

  it("falls back to GH_TOKEN when GITHUB_TOKEN is missing", async () => {
    const layer = makeTestEnvironment({ GH_TOKEN: "gho_fallback" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("gho_fallback")
  })

  it("prefers GITHUB_TOKEN over GH_TOKEN", async () => {
    const layer = makeTestEnvironment({
      GITHUB_TOKEN: "ghp_primary",
      GH_TOKEN: "gho_secondary",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("ghp_primary")
  })

  it("returns undefined when neither is set", async () => {
    const layer = makeTestEnvironment({})
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("detectCliCredentials", () => {
  it("returns token from successful gh auth token", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "gh",
        args: ["auth", "token"],
        outputLines: ["ghp_cli_token"],
        exitCode: 0,
      }]),
      makeTestEnvironment(),
    )

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("ghp_cli_token")
  })

  it("returns undefined when command fails", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "gh",
        args: ["auth", "token"],
        outputLines: [],
        exitCode: 1,
      }]),
      makeTestEnvironment(),
    )

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})
