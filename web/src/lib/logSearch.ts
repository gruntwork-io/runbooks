/**
 * Search inside a log view. Matching runs on the log lines themselves, as
 * TerminalText shows them (lib/logs' shownText), rather than on the page, so
 * the count covers the whole log whatever is rendered, and timestamps never
 * match. The matches are then placed on the rendered lines by offset and
 * painted with the CSS Custom Highlight API, as find in page paints its own
 * (lib/findInPage).
 */
import {
  FIND_IGNORE_ATTRIBUTE,
  highlightRegistry,
  rangeInRun,
  type TextRun,
} from "@/lib/findInPage"
import { shownText } from "@/lib/logs"

/** CSS.highlights names; ViewLogs.css styles them with ::highlight(). */
export const LOG_MATCH_HIGHLIGHT = "runbooks-log-match"
export const LOG_ACTIVE_HIGHLIGHT = "runbooks-log-active"

/** A place in a log: a line's index, and an offset in its shown text. */
export interface LogPosition {
  line: number
  start: number
}

/** A match in a log, from `start` to `end` of its line's shown text. */
export interface LogMatch extends LogPosition {
  end: number
}

/** A line of log output, such as a LogEntry. */
interface LogLine {
  line: string
}

/** The first and last lines on screen in a log view. */
export interface LineSpan {
  first: number
  last: number
}

/**
 * Where `pattern` (a global RegExp) matches `text`. An empty match, such as
 * one for `^` or `x*`, is skipped: there is nothing to show.
 */
function matchesIn(text: string, pattern: RegExp): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = []
  for (const m of text.matchAll(pattern)) {
    if (m[0]) found.push({ start: m.index, end: m.index + m[0].length })
  }
  return found
}

/**
 * Each line's matches for the last few patterns, so a log that grows as a
 * run streams in only matches its new lines.
 */
const lineMatches = new Map<string, WeakMap<LogLine, { start: number; end: number }[]>>()
const CACHED_PATTERNS = 8

/** Every match of `pattern` (a global RegExp) in `lines`, in order. */
export function findLogMatches(lines: readonly LogLine[], pattern: RegExp | null): LogMatch[] {
  if (!pattern) return []
  const key = `${pattern.flags}/${pattern.source}`
  let cache = lineMatches.get(key)
  if (!cache) {
    cache = new WeakMap()
    lineMatches.set(key, cache)
    if (lineMatches.size > CACHED_PATTERNS) lineMatches.delete(lineMatches.keys().next().value!)
  }
  const matches: LogMatch[] = []
  for (const [line, entry] of lines.entries()) {
    let found = cache.get(entry)
    if (!found) {
      found = matchesIn(shownText(entry.line), pattern)
      cache.set(entry, found)
    }
    for (const { start, end } of found) matches.push({ line, start, end })
  }
  return matches
}

/**
 * The index of the first match at or after `anchor`, so a search carries on
 * from its current match; past every match, the last one, which is the
 * closest. -1 without matches.
 */
export function matchAtOrAfter(matches: readonly LogMatch[], anchor: LogPosition): number {
  if (matches.length === 0) return -1
  const index = matches.findIndex(
    (m) => m.line > anchor.line || (m.line === anchor.line && m.start >= anchor.start),
  )
  return index < 0 ? matches.length - 1 : index
}

/**
 * Where a new search starts: the first match on screen, else the closest one
 * above the screen, since a log is mostly read from its end; else the first
 * one below. Without `view` (nothing laid out yet) that is the last match: a
 * log view opens at its end. -1 without matches.
 */
export function startMatch(matches: readonly LogMatch[], view: LineSpan | null): number {
  if (matches.length === 0) return -1
  if (!view) return matches.length - 1
  let above = -1
  for (const [i, m] of matches.entries()) {
    if (m.line < view.first) above = i
    else return m.line <= view.last || above < 0 ? i : above
  }
  return above
}

/** The lines with a match, each once, in order. */
export function matchingLines(matches: readonly LogMatch[]): number[] {
  const lines: number[] = []
  for (const { line } of matches) if (lines.at(-1) !== line) lines.push(line)
  return lines
}

/**
 * Where the matches fall in a log of `lineCount` lines, as fractions of its
 * height. Matches close together share a mark, so there are at most
 * `marks` + 1 of them however many matches there are.
 */
export function matchMarks(matches: readonly LogMatch[], lineCount: number, marks = 200): number[] {
  if (lineCount === 0) return []
  const buckets = new Set<number>()
  for (const { line } of matches) buckets.add(Math.round(((line + 0.5) / lineCount) * marks))
  return [...buckets].map((bucket) => bucket / marks)
}

/**
 * Ranges for `matches`, found in `text`, on the rendered line `el`. They are
 * placed by offset, in the text under `el` without the subtrees marked with
 * FIND_IGNORE_ATTRIBUTE, such as the line's timestamp. When that text doesn't
 * read as `text`, an offset could land on other characters, so no match is
 * placed: each is null.
 */
export function rangesIn(
  el: Element,
  text: string,
  matches: readonly { start: number; end: number }[],
): (Range | null)[] {
  const run: TextRun = { text: "", nodes: [] }
  const walker = el.ownerDocument.createTreeWalker(
    el,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.TEXT_NODE
          ? NodeFilter.FILTER_ACCEPT
          : (node as Element).hasAttribute(FIND_IGNORE_ATTRIBUTE)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP,
    },
  )
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    run.nodes.push({ node: textNode, start: run.text.length })
    run.text += textNode.data
  }
  if (run.text !== text) return matches.map(() => null)
  return matches.map(({ start, end }) => rangeInRun(run, start, end))
}

/**
 * What each open log search has painted, by owner. One pair of highlights
 * holds them all, so a search in one log doesn't wipe out another's.
 */
const painted = new Map<object, { ranges: Range[]; current: Range | null }>()

function repaint(): void {
  const registry = highlightRegistry()
  if (!registry) return
  if (painted.size === 0) {
    registry.delete(LOG_MATCH_HIGHLIGHT)
    registry.delete(LOG_ACTIVE_HIGHLIGHT)
    return
  }
  // add() one at a time: spreading thousands of ranges into the constructor
  // can exceed the argument limit.
  const all = new Highlight()
  const active = new Highlight()
  active.priority = 1
  for (const { ranges, current } of painted.values()) {
    for (const range of ranges) all.add(range)
    if (current) active.add(current)
  }
  registry.set(LOG_MATCH_HIGHLIGHT, all)
  registry.set(LOG_ACTIVE_HIGHLIGHT, active)
}

/** Paint `owner`'s matches, and its current one on top, replacing what it painted before. */
export function paintLogMatches(owner: object, ranges: Range[], current: Range | null): void {
  painted.set(owner, { ranges, current })
  repaint()
}

/** Remove what `owner` painted. */
export function clearLogMatches(owner: object): void {
  if (painted.delete(owner)) repaint()
}
