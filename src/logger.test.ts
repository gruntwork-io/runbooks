import { describe, it, expect } from "bun:test"
import { compilePatterns, matchesPatterns, makeLogger } from "./logger.ts"

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
