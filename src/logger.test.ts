import { describe, it, expect, afterEach, spyOn } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { compilePatterns, matchesPatterns, makeLogger } from "./logger.ts"
import { clearRegisteredSecrets, registerSecret } from "./domain/vcs/redact.ts"
import { GitError, SpawnError } from "./errors/index.ts"

describe("compilePatterns", () => {
  it("returns empty array for undefined", () => {
    expect(compilePatterns(undefined)).toEqual([])
  })

  it("returns empty array for empty string", () => {
    expect(compilePatterns("")).toEqual([])
  })

  it("ignores whitespace and empty entries", () => {
    expect(compilePatterns("  ,, ")).toEqual([])
  })
})

describe("matchesPatterns", () => {
  it("matches nothing when no patterns set", () => {
    const p = compilePatterns(undefined)
    expect(matchesPatterns("ipc:exec", p)).toBe(false)
  })

  it("matches everything with *", () => {
    const p = compilePatterns("*")
    expect(matchesPatterns("ipc:exec", p)).toBe(true)
    expect(matchesPatterns("git:clone", p)).toBe(true)
  })

  it("matches an exact tag", () => {
    const p = compilePatterns("ipc:exec")
    expect(matchesPatterns("ipc:exec", p)).toBe(true)
    expect(matchesPatterns("ipc:git", p)).toBe(false)
    expect(matchesPatterns("ipc:exec:foo", p)).toBe(false)
  })

  it("matches a namespace prefix with :*", () => {
    const p = compilePatterns("ipc:*")
    expect(matchesPatterns("ipc:exec", p)).toBe(true)
    expect(matchesPatterns("ipc:git", p)).toBe(true)
    expect(matchesPatterns("ipc", p)).toBe(false)
    expect(matchesPatterns("git:clone", p)).toBe(false)
  })

  it("combines multiple patterns with comma", () => {
    const p = compilePatterns("ipc:exec, git:*")
    expect(matchesPatterns("ipc:exec", p)).toBe(true)
    expect(matchesPatterns("git:clone", p)).toBe(true)
    expect(matchesPatterns("ipc:git", p)).toBe(false)
  })

  it("supports negation to disable a tag", () => {
    const p = compilePatterns("ipc:*,-ipc:exec")
    expect(matchesPatterns("ipc:git", p)).toBe(true)
    expect(matchesPatterns("ipc:exec", p)).toBe(false)
  })

  it("evaluates patterns left-to-right so order matters", () => {
    // disable, then re-enable
    const p = compilePatterns("-ipc:exec,ipc:*")
    expect(matchesPatterns("ipc:exec", p)).toBe(true)
  })
})

describe("makeLogger", () => {
  it("returns a logger with all four levels", () => {
    const log = makeLogger("test")
    expect(typeof log.debug).toBe("function")
    expect(typeof log.info).toBe("function")
    expect(typeof log.warn).toBe("function")
    expect(typeof log.error).toBe("function")
  })

  it("does not throw when called", () => {
    const log = makeLogger("test")
    expect(() => log.debug("x")).not.toThrow()
    expect(() => log.info("x")).not.toThrow()
    expect(() => log.warn("x")).not.toThrow()
    expect(() => log.error("x")).not.toThrow()
  })
})

describe("makeLogger error formatting", () => {
  const SECRET = "s3cr3t-token-value"

  afterEach(() => {
    clearRegisteredSecrets()
  })

  /** Log `args` through log.error and return everything that reached the console. */
  function logged(...args: unknown[]): string {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      makeLogger("test").error(...args)
      return spy.mock.calls.flat().map(String).join(" ")
    } finally {
      spy.mockRestore()
    }
  }

  function cloneError(): GitError {
    return new GitError({
      command: `clone https://x-access-token:${SECRET}@github.com/o/r.git`,
      stderr: `fatal: repository not found (token ${SECRET})`,
      exitCode: 128,
    })
  }

  async function rejectionOf(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
    const runtime = ManagedRuntime.make(Layer.empty)
    try {
      return await runtime.runPromise(effect).then(
        () => {
          throw new Error("expected the effect to fail")
        },
        (err: unknown) => err,
      )
    } finally {
      await runtime.dispose()
    }
  }

  it("keeps a TaggedError's fields and redacts the secret in them", () => {
    registerSecret(SECRET)
    const out = logged("clone failed:", cloneError())
    expect(out).toContain("GitError")
    expect(out).toContain("stderr")
    expect(out).toContain("fatal: repository not found")
    expect(out).toContain("128")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain(SECRET)
  })

  it("does not truncate a long field before redacting it", () => {
    // Unprefixed 64-hex, like a GitLab OAuth token: only exact-match redaction catches it.
    const token = "0123456789abcdef".repeat(4)
    registerSecret(token)
    const prefix = "fatal: unable to access 'https://oauth2:"
    const tail = "@gitlab.example.com/o/r.git/': The requested URL returned error: 403"
    // The token straddles position 10000, util.inspect's default maxStringLength.
    const stderr = "x".repeat(10_000 - 32 - prefix.length) + prefix + token + tail
    const out = logged(new GitError({ command: "clone", stderr, exitCode: 128 }))
    expect(out).toContain(tail)
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain(token.slice(0, 16))
  })

  it("unwraps a FiberFailure from runPromise to the error it failed with", async () => {
    registerSecret(SECRET)
    const err = await rejectionOf(Effect.fail(cloneError()))
    const out = logged("Failed to resolve remote URL:", err)
    expect(out).toContain("GitError")
    expect(out).toContain("stderr")
    expect(out).toContain("fatal: repository not found")
    expect(out).toContain("128")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain(SECRET)
  })

  it("unwraps defects and says so for interruption-only failures", async () => {
    const died = logged(await rejectionOf(Effect.die(new Error("boom in a fiber"))))
    expect(died).toContain("boom in a fiber")
    const interrupted = logged(await rejectionOf(Effect.interrupt))
    expect(interrupted).toContain("interrupted")
  })

  it("follows the cause chain and redacts it", () => {
    registerSecret(SECRET)
    const err = new SpawnError({
      command: "git ls-remote",
      cause: new Error(`spawn git ENOENT (${SECRET})`),
    })
    const out = logged(err)
    expect(out).toContain("git ls-remote")
    expect(out).toContain("[cause]")
    expect(out).toContain("spawn git ENOENT")
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain(SECRET)
  })

  it("prints a non-Error cause", () => {
    const out = logged(new Error("outer", { cause: { code: "EACCES" } }))
    expect(out).toContain("[cause]")
    expect(out).toContain("EACCES")
  })

  it("falls back to the stack instead of throwing when a field getter throws", () => {
    registerSecret(SECRET)
    const err = new Error(`clone failed for ${SECRET}`)
    Object.defineProperty(err, "detail", {
      enumerable: true,
      get() {
        throw new Error("getter threw")
      },
    })
    let out = ""
    expect(() => {
      out = logged(err)
    }).not.toThrow()
    expect(out).toContain("clone failed for [REDACTED]")
    expect(out).not.toContain(SECRET)
  })

  it("stops following a cyclic cause chain", () => {
    const a = new Error("first")
    const b = new Error("second", { cause: a })
    a.cause = b
    const out = logged(a)
    expect(out.match(/\[cause\]/g)?.length).toBe(4)
  })
})
