import { describe, expect, it } from "bun:test"
import { lineSplitter } from "./lineSplitter.ts"

/** The lines `chunks` split into, written one after another, then ended. */
function split(chunks: ReadonlyArray<string | Buffer>, maxLength?: number): string[] {
  const lines: string[] = []
  const splitter = lineSplitter((line) => lines.push(line), maxLength)
  for (const chunk of chunks) splitter.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  splitter.end()
  return lines
}

describe("lineSplitter", () => {
  it("ends a line at \\n, \\r\\n or a lone \\r, as readline does", () => {
    expect(split(["a\nb\r\nc\rd\n\ne"])).toEqual(["a", "b", "c", "d", "", "e"])
  })

  it("holds a line until it ends, across writes", () => {
    expect(split(["ab", "c\nd", "e"])).toEqual(["abc", "de"])
  })

  it("reads a \\r\\n split across two writes as one line break", () => {
    expect(split(["a\r", "\nb"])).toEqual(["a", "b"])
  })

  it("ends a line at a \\r last in the stream", () => {
    expect(split(["a\r"])).toEqual(["a"])
  })

  it("keeps a multi-byte character split across writes whole", () => {
    const bytes = Buffer.from("é\n")
    expect(split([bytes.subarray(0, 1), bytes.subarray(1)])).toEqual(["é"])
  })

  it("gives a line longer than the limit in pieces of the limit, holding no more", () => {
    expect(split(["abcdefg", "hij\nk"], 4)).toEqual(["abcd", "efgh", "ij", "k"])
  })

  it("never ends a piece between the halves of a surrogate pair", () => {
    expect(split(["ab😀cd\n"], 3)).toEqual(["ab", "😀c", "d"])
  })

  it("emits nothing for an empty stream", () => {
    expect(split([])).toEqual([])
  })
})
