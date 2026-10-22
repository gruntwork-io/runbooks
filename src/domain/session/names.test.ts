import { describe, it, expect } from "bun:test"
import { SESSION_NAME_MAX_LENGTH, sessionNameCandidates, sessionNameProblem } from "./names.ts"

/** A `random` that returns `values` in turn, then repeats the last one. */
function sequence(values: number[]): () => number {
  let next = 0
  return () => values[Math.min(next++, values.length - 1)]!
}

describe("sessionNameCandidates", () => {
  it("starts with random adjective-noun pairs", () => {
    // adjective, noun, adjective, noun, ...
    const [first, second] = sessionNameCandidates(sequence([0, 0, 0.999, 0.999]), "id")

    expect(first).toBe("agile-acorn")
    expect(second).toBe("zesty-zebra")
  })

  it("only offers lowercase words joined by one hyphen as plain names", () => {
    for (let round = 0; round < 200; round++) {
      const plain = sessionNameCandidates(() => Math.random(), "id").slice(0, 10)
      for (const name of plain) expect(name).toMatch(/^[a-z]+-[a-z]+$/)
    }
  })

  it("goes on to one pair with numbers from 2, and ends with that pair and the unique suffix", () => {
    const candidates = sessionNameCandidates(() => 0, "0199a5c2-7e3b-7c4d-9a1f-3b2c4d5e6f70")

    expect(candidates.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => "agile-acorn"))
    expect(candidates.slice(10, 12)).toEqual(["agile-acorn-2", "agile-acorn-3"])
    expect(candidates.at(-2)).toBe("agile-acorn-20")
    expect(candidates.at(-1)).toBe("agile-acorn-0199a5c2-7e3b-7c4d-9a1f-3b2c4d5e6f70")
    expect(candidates).toHaveLength(30)
  })

  it("stays inside the word lists when the random source returns 1", () => {
    expect(sessionNameCandidates(() => 1, "id")[0]).toBe("zesty-zebra")
  })

  it("only offers names a session is allowed to have, the one with a UUID included", () => {
    for (let round = 0; round < 200; round++) {
      const candidates = sessionNameCandidates(
        () => Math.random(),
        "0199a5c2-7e3b-7c4d-9a1f-3b2c4d5e6f70",
      )
      for (const name of candidates) expect(sessionNameProblem(name)).toBeUndefined()
    }
  })
})

describe("sessionNameProblem", () => {
  it.each([
    "elegant-elephant",
    "a",
    "7",
    "prod-deploy-2",
    "release-2026-10-02",
    "a".repeat(SESSION_NAME_MAX_LENGTH),
  ])("allows %s", (name) => {
    expect(sessionNameProblem(name)).toBeUndefined()
  })

  it("asks for a name when it is empty", () => {
    expect(sessionNameProblem("")).toBe("Enter a name.")
  })

  it("limits a name to 63 characters", () => {
    expect(SESSION_NAME_MAX_LENGTH).toBe(63)
    expect(sessionNameProblem("a".repeat(64))).toBe("A session name can be at most 63 characters.")
  })

  it.each([
    ["an uppercase letter", "Elegant-elephant"],
    ["a space", "elegant elephant"],
    ["an underscore", "elegant_elephant"],
    ["a dot", "elegant.elephant"],
    ["a slash", "elegant/elephant"],
    ["a parent directory", ".."],
    ["a letter outside a-z", "élégant"],
    ["an emoji", "elegant-🐘"],
    ["a leading hyphen", "-elephant"],
    ["a trailing hyphen", "elegant-"],
    ["two hyphens in a row", "elegant--elephant"],
    ["whitespace around it", " elegant-elephant "],
    ["a newline", "elegant\nelephant"],
  ])("rejects %s", (_what, name) => {
    expect(sessionNameProblem(name)).toMatch(/^Use lowercase letters, digits and hyphens/)
  })
})
