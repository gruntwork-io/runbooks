import { describe, it, expect } from "bun:test"
import { sessionNameCandidates } from "./names.ts"

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
    const candidates = sessionNameCandidates(() => 0, "3f9c2a61b0e84d17")

    expect(candidates.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => "agile-acorn"))
    expect(candidates.slice(10, 12)).toEqual(["agile-acorn-2", "agile-acorn-3"])
    expect(candidates.at(-2)).toBe("agile-acorn-20")
    expect(candidates.at(-1)).toBe("agile-acorn-3f9c2a61b0e84d17")
    expect(candidates).toHaveLength(30)
  })

  it("stays inside the word lists when the random source returns 1", () => {
    expect(sessionNameCandidates(() => 1, "id")[0]).toBe("zesty-zebra")
  })
})
