/**
 * MDX fence/block detection ported from api/mdx.go.
 */

/** Matches fence marker lines (``` or ~~~) with optional leading whitespace. */
const FENCE_LINE_REGEX = /^\s*(?:```|~~~)/gm

/** Matches complete fenced code blocks (opening + content + closing). */
const FENCED_BLOCK_REGEX = /^\s*(?:```|~~~).*\n(?:.*\n)*?^\s*(?:```|~~~)\s*$/gm

/**
 * Finds all fenced code block ranges as [start, end] position pairs.
 * Used to prevent parsing documentation examples inside code fences.
 */
export function findFencedCodeBlockRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const matches: number[] = []

  FENCE_LINE_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_LINE_REGEX.exec(content)) !== null) {
    matches.push(m.index)
  }

  // Pair consecutive fence markers
  for (let i = 0; i + 1 < matches.length; i += 2) {
    ranges.push([matches[i], matches[i + 1]])
  }
  return ranges
}

/**
 * Returns true if `position` falls inside any fenced code block.
 */
export function isInsideFencedCodeBlock(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position >= start && position <= end)
}

/**
 * Strips fenced code blocks from MDX content.
 * Prevents false positives when parsing component references in documentation.
 */
export function stripFencedCodeBlocks(content: string): string {
  return content.replace(FENCED_BLOCK_REGEX, "")
}
