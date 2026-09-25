/**
 * Matches fence marker lines (``` or ~~~ runs of 3+) and captures an optional
 * list-item marker before the run (`- ```bash`, `1. ```bash`), the run, and
 * the rest of the line. Any indent is allowed because MDX turns off indented
 * code; `[ \t]*` (not `\s*`) keeps a match from starting on an earlier line.
 * Other container prefixes (`> ````) are not recognised.
 */
const FENCE_LINE_REGEX = /^[ \t]*((?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/gm

/**
 * Finds all fenced code block ranges as [start, end] position pairs.
 * Used to prevent parsing documentation examples inside code fences.
 *
 * Fences pair the way CommonMark pairs them: a block closes only on a run of
 * the same character that is at least as long as the opener and has nothing
 * after it. A nested ```mdx example inside a ```` fence, or an indented
 * ```yaml line inside a ```mdx fence, is content rather than a closer. An
 * unclosed fence runs to the end of the content.
 */
export function findFencedCodeBlockRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let open: { start: number; char: string; length: number } | null = null

  FENCE_LINE_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_LINE_REGEX.exec(content)) !== null) {
    const listMarker = m[1]
    const run = m[2]!
    const rest = m[3]!
    const char = run[0]!

    if (!open) {
      // A backtick opener's info string can't contain backticks (```x``` is inline code)
      if (char === "`" && rest.includes("`")) continue
      open = { start: m.index, char, length: run.length }
    } else if (
      // A list-item line inside a fence is content: only a bare run closes it
      !listMarker &&
      char === open.char &&
      run.length >= open.length &&
      rest.trim() === ""
    ) {
      ranges.push([open.start, m.index + m[0].length])
      open = null
    }
  }

  if (open) ranges.push([open.start, content.length])
  return ranges
}

/**
 * Returns true if `position` falls inside any fenced code block.
 */
export function isInsideFencedCodeBlock(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position >= start && position <= end)
}
