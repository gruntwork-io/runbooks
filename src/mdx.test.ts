import { describe, it, expect } from "bun:test"
import {
  findFencedCodeBlockRanges,
  isInsideFencedCodeBlock,
  stripFencedCodeBlocks,
} from "./mdx.ts"

describe("findFencedCodeBlockRanges", () => {
  it("returns empty for content without fences", () => {
    expect(findFencedCodeBlockRanges("hello world")).toEqual([])
  })

  it("returns one range for a single fenced block", () => {
    const content = "before\n```\ncode\n```\nafter"
    const ranges = findFencedCodeBlockRanges(content)
    expect(ranges).toHaveLength(1)
    expect(ranges[0][0]).toBeLessThan(ranges[0][1])
  })

  it("returns multiple ranges for multiple blocks", () => {
    const content = "```\nblock1\n```\ntext\n```\nblock2\n```"
    const ranges = findFencedCodeBlockRanges(content)
    expect(ranges).toHaveLength(2)
  })

  it("handles triple-tilde syntax", () => {
    const content = "before\n~~~\ncode\n~~~\nafter"
    const ranges = findFencedCodeBlockRanges(content)
    expect(ranges).toHaveLength(1)
  })

  it("handles leading whitespace", () => {
    const content = "  ```\ncode\n  ```"
    const ranges = findFencedCodeBlockRanges(content)
    expect(ranges).toHaveLength(1)
  })
})

describe("isInsideFencedCodeBlock", () => {
  it("returns true for position inside a range", () => {
    const ranges: Array<[number, number]> = [[5, 20]]
    expect(isInsideFencedCodeBlock(10, ranges)).toBe(true)
  })

  it("returns false for position outside all ranges", () => {
    const ranges: Array<[number, number]> = [[5, 20]]
    expect(isInsideFencedCodeBlock(25, ranges)).toBe(false)
  })

  it("returns true at boundary start", () => {
    const ranges: Array<[number, number]> = [[5, 20]]
    expect(isInsideFencedCodeBlock(5, ranges)).toBe(true)
  })

  it("returns true at boundary end", () => {
    const ranges: Array<[number, number]> = [[5, 20]]
    expect(isInsideFencedCodeBlock(20, ranges)).toBe(true)
  })
})

describe("stripFencedCodeBlocks", () => {
  it("removes fenced blocks and preserves surrounding content", () => {
    const content = "before\n```\ncode here\n```\nafter"
    const result = stripFencedCodeBlocks(content)
    expect(result).toContain("before")
    expect(result).toContain("after")
    expect(result).not.toContain("code here")
  })

  it("handles multiple blocks", () => {
    const content = "a\n```\nb\n```\nc\n```\nd\n```\ne"
    const result = stripFencedCodeBlocks(content)
    expect(result).toContain("a")
    expect(result).toContain("c")
    expect(result).toContain("e")
    expect(result).not.toContain("b")
    expect(result).not.toContain("d")
  })

  it("returns content unchanged if no fences", () => {
    const content = "no fences here"
    expect(stripFencedCodeBlocks(content)).toBe(content)
  })
})
