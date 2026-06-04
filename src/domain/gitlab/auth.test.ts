import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { detectTokenType, detectEnvCredentials, detectCliCredentials } from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestSpawner } from "../../test-utils/TestSpawner.ts"

describe("detectTokenType", () => {
  it("identifies a personal access token", () => {
    expect(detectTokenType("glpat-abc123")).toBe("pat")
  })

  it("returns unknown for an unrecognized prefix", () => {
    expect(detectTokenType("random_token")).toBe("unknown")
  })

  it("returns unknown for an empty string", () => {
    expect(detectTokenType("")).toBe("unknown")
  })
})

describe("detectEnvCredentials", () => {
  it("returns GITLAB_TOKEN when set", async () => {
    const layer = makeTestEnvironment({ GITLAB_TOKEN: "glpat-test123" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-test123")
  })

  it("returns undefined when GITLAB_TOKEN is not set", async () => {
    const layer = makeTestEnvironment({})
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("does not read GITHUB_TOKEN", async () => {
    const layer = makeTestEnvironment({ GITHUB_TOKEN: "ghp_should_be_ignored" })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("detectCliCredentials", () => {
  it("returns token from a successful `glab auth token`", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "glab",
        args: ["auth", "token"],
        outputLines: ["glpat-cli_token"],
        exitCode: 0,
      }]),
      makeTestEnvironment(),
    )

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat-cli_token")
  })

  it("returns undefined when the command fails", async () => {
    const layer = Layer.merge(
      makeTestSpawner([{
        command: "glab",
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

  it("returns undefined when the CLI is not installed", async () => {
    // No expectation registered for `glab` → the spawner fails, mirroring a
    // missing binary.
    const layer = Layer.merge(makeTestSpawner([]), makeTestEnvironment())

    const result = await Effect.runPromise(
      detectCliCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})
