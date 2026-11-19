import { describe, it, expect } from "vitest"
import { queryPattern } from "./findInPage"
import {
  findLogMatches,
  matchAtOrAfter,
  matchingLines,
  matchMarks,
  rangesIn,
  startMatch,
  type LogMatch,
} from "./logSearch"

const lines = (...text: string[]) => text.map((line) => ({ line }))

/** Matches as [line, start, end] triples, to read at a glance. */
const triples = (matches: LogMatch[]) => matches.map((m) => [m.line, m.start, m.end])

describe("findLogMatches", () => {
  it("matches each line's text with its ANSI codes stripped", () => {
    const log = lines("\u001b[32mCreation complete\u001b[0m", "nothing here", "creation complete")
    expect(triples(findLogMatches(log, queryPattern("creation")))).toEqual([
      [0, 0, 8],
      [2, 0, 8],
    ])
  })

  it("finds several matches in one line, in order", () => {
    expect(triples(findLogMatches(lines("a nat, a nat"), queryPattern("nat")))).toEqual([
      [0, 2, 5],
      [0, 9, 12],
    ])
  })

  it("matches case and regular expressions when asked", () => {
    const log = lines("Error: one", "error: two", "warning: three")
    expect(findLogMatches(log, queryPattern("Error", { matchCase: true }))).toHaveLength(1)
    expect(triples(findLogMatches(log, queryPattern("^(error|warning)", { regex: true })))).toEqual(
      [
        [0, 0, 5],
        [1, 0, 5],
        [2, 0, 7],
      ],
    )
  })

  it("skips empty matches, which have nothing to show", () => {
    expect(triples(findLogMatches(lines("aab", "b"), queryPattern("a*", { regex: true })))).toEqual(
      [[0, 0, 2]],
    )
  })

  it("matches nothing without a pattern", () => {
    expect(findLogMatches(lines("anything"), null)).toEqual([])
  })

  it("matches a line that replaced another, as a run's progress line does", () => {
    const first = lines("10% done", "nothing")
    expect(findLogMatches(first, queryPattern("done"))).toHaveLength(1)
    const replaced = [first[0]!, { line: "20% done, done" }]
    expect(triples(findLogMatches(replaced, queryPattern("done")))).toEqual([
      [0, 4, 8],
      [1, 4, 8],
      [1, 10, 14],
    ])
  })
})

describe("matchAtOrAfter", () => {
  const matches: LogMatch[] = [
    { line: 2, start: 0, end: 3 },
    { line: 2, start: 6, end: 9 },
    { line: 7, start: 1, end: 4 },
  ]

  it("finds the match at or after a position, else the last one", () => {
    expect(matchAtOrAfter(matches, { line: 2, start: 6 })).toBe(1)
    expect(matchAtOrAfter(matches, { line: 2, start: 1 })).toBe(1)
    expect(matchAtOrAfter(matches, { line: 0, start: 0 })).toBe(0)
    expect(matchAtOrAfter(matches, { line: 9, start: 0 })).toBe(2)
    expect(matchAtOrAfter([], { line: 0, start: 0 })).toBe(-1)
  })
})

describe("startMatch", () => {
  // Matches on lines 5, 40, 41 and 90.
  const matches: LogMatch[] = [5, 40, 41, 90].map((line) => ({ line, start: 0, end: 1 }))

  it("starts on the first match on screen", () => {
    expect(startMatch(matches, { first: 30, last: 60 })).toBe(1)
  })

  it("takes the closest match above when none is on screen", () => {
    expect(startMatch(matches, { first: 50, last: 80 })).toBe(2)
    expect(startMatch(matches, { first: 95, last: 120 })).toBe(3)
  })

  it("takes the first match below when none is on screen or above", () => {
    expect(startMatch(matches, { first: 0, last: 3 })).toBe(0)
  })

  it("starts on the last match without a view, as a log opens at its end", () => {
    expect(startMatch(matches, null)).toBe(3)
  })

  it("has no start without matches", () => {
    expect(startMatch([], { first: 0, last: 10 })).toBe(-1)
  })
})

describe("matchingLines", () => {
  it("lists each line with a match once", () => {
    const matches: LogMatch[] = [
      { line: 1, start: 0, end: 1 },
      { line: 1, start: 4, end: 5 },
      { line: 3, start: 0, end: 1 },
    ]
    expect(matchingLines(matches)).toEqual([1, 3])
  })
})

describe("matchMarks", () => {
  it("places each match's line as a fraction of the log", () => {
    const matches: LogMatch[] = [{ line: 0, start: 0, end: 1 }]
    expect(matchMarks(matches, 2, 100)).toEqual([0.25])
  })

  it("merges matches too close together to tell apart", () => {
    const matches: LogMatch[] = Array.from({ length: 1000 }, (_, line) => ({
      line,
      start: 0,
      end: 1,
    }))
    const marks = matchMarks(matches, 1000, 200)
    expect(marks.length).toBeLessThanOrEqual(201)
    expect(marks[0]).toBe(0)
    expect(marks.at(-1)).toBe(1)
  })

  it("has no marks for an empty log", () => {
    expect(matchMarks([], 0)).toEqual([])
  })
})

describe("rangesIn", () => {
  it("finds matches across inline elements, leaving out ignored text", () => {
    const line = document.createElement("div")
    line.innerHTML =
      '<span data-find-ignore="">12:00:01 nat</span><span><span class="ansi-green-fg">aws_na</span>t_gateway.main[2]</span>'
    const ranges = rangesIn(line, queryPattern("nat")!)
    expect(ranges.map((range) => range.toString())).toEqual(["nat"])
    expect(ranges[0]!.startContainer.textContent).toBe("aws_na")
  })
})
