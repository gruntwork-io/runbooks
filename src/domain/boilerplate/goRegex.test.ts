import { describe, it, expect } from "bun:test"
import { compileGoRegex } from "./goRegex.ts"

function matches(pattern: string, value: string): boolean {
  const compiled = compileGoRegex(pattern)
  if ("error" in compiled) throw new Error(compiled.error)
  return compiled.regex.test(value)
}

function problem(pattern: string): string | undefined {
  const compiled = compileGoRegex(pattern)
  return "error" in compiled ? compiled.error : undefined
}

describe("compileGoRegex", () => {
  it("checks a typical pattern as Go does, searching the whole value unanchored", () => {
    expect(matches("^[a-z0-9][a-z0-9-]{0,62}$", "my-storage-1")).toBe(true)
    expect(matches("^[a-z0-9][a-z0-9-]{0,62}$", "-leading-dash")).toBe(false)
    expect(matches("[0-9]", "abc1")).toBe(true)
  })

  it("matches one character per code point, as Go does per rune", () => {
    expect(matches("^.$", "é")).toBe(true)
    expect(matches("^.$", "😀")).toBe(true)
  })

  it("takes Go's leading flags", () => {
    expect(matches("(?i)^abc$", "ABC")).toBe(true)
    expect(matches("(?s)^a.b$", "a\nb")).toBe(true)
    expect(matches("^a.b$", "a\nb")).toBe(false)
  })

  it("takes punctuation escapes JavaScript rejects in unicode mode", () => {
    expect(matches("^\\d+\\-\\d+$", "12-34")).toBe(true)
    expect(matches("^[\\@\\-]+$", "@-@")).toBe(true)
    expect(matches("^a\\_b\\:c$", "a_b:c")).toBe(true)
  })

  it("takes Go's spellings of classes, escapes and groups", () => {
    expect(matches("^[[:alpha:]_]+$", "ab_C")).toBe(true)
    expect(matches("^[[:alpha:]_]+$", "ab1")).toBe(false)
    expect(matches("^[]a]+$", "a]a")).toBe(true)
    expect(matches("^\\Qa.b\\E$", "a.b")).toBe(true)
    expect(matches("^\\Qa.b\\E$", "axb")).toBe(false)
    expect(matches("\\Aab\\z", "ab")).toBe(true)
    expect(matches("\\Aab\\z", "ab\n")).toBe(false)
    expect(matches("^\\pL+$", "héllo")).toBe(true)
    expect(matches("^\\p{Greek}+$", "αβγ")).toBe(true)
    expect(matches("^(?P<word>x)$", "x")).toBe(true)
    expect(matches("^\\x{1F600}$", "😀")).toBe(true)
    expect(matches("^a{$", "a{")).toBe(true)
    expect(matches("^a{2,3}$", "aa")).toBe(true)
  })

  it("explains a pattern it can't check instead of throwing", () => {
    expect(problem("[a-z")).toBeDefined()
    expect(problem("(?=x)")).toBe("Go doesn't support lookahead or lookbehind")
    expect(problem("(?<!x)y")).toBe("Go doesn't support lookahead or lookbehind")
    expect(problem("(\\w)\\1")).toBe("Go doesn't support backreferences such as \\1")
    expect(problem("(?U)a+")).toBe("the U (ungreedy) flag has no JavaScript equivalent")
    expect(problem("abc\\")).toBe("trailing backslash at end of expression")
  })
})
