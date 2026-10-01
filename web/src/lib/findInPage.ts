/**
 * Find in page: text matching, highlighting and scrolling for the find bar.
 *
 * Electron's webContents.findInPage can't back an in-page find bar: Chromium
 * counts the text in the bar's own <input> as a match, and every call clears
 * the focused element, so keystrokes typed after a search are lost. Instead,
 * the renderer matches text itself and paints matches with the CSS Custom
 * Highlight API, which moves neither focus nor the selection.
 */

/** CSS.highlights names; FindBar.css styles them with ::highlight(). */
export const FIND_MATCH_HIGHLIGHT = "runbooks-find-match"
export const FIND_ACTIVE_HIGHLIGHT = "runbooks-find-active"

/** Elements whose text is never shown as page text, or can't hold a match. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT"])

/**
 * Elements that start a new line of text. A match may span inline elements
 * (a highlighted code token, inline code, bold text) but not these, so "foo"
 * in one paragraph and "bar" in the next never make a "foobar" match. A tag
 * heuristic rather than computed styles, which would be far slower.
 */
const BLOCK_SELECTOR = [
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "button",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
].join(",")

/**
 * Marks a subtree the search leaves out: the find bar itself, and app chrome
 * such as the header, whose runbook path is always on screen and would
 * otherwise be where every search that matches the path starts.
 */
export const FIND_IGNORE_ATTRIBUTE = "data-find-ignore"

/**
 * A case-insensitive pattern for `query` that treats every character
 * literally, except that a run of whitespace matches any run of whitespace:
 * text nodes keep the line breaks and repeated spaces that render as one space.
 */
function queryPattern(query: string): RegExp | null {
  if (!query.trim()) return null
  const source = query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\s+/g, "\\s+")
  return new RegExp(source, "giu")
}

interface Run {
  text: string
  /** Each text node in the run and the offset of its first character in `text`. */
  nodes: { node: Text; start: number }[]
}

/**
 * The text node holding `offset` of `run`; `end` picks the node a match ends in.
 * `run` has text, so it has at least one node.
 */
function locate(run: Run, offset: number, end: boolean): { node: Text; offset: number } {
  const { nodes } = run
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { node, start } = nodes[i]!
    if (end ? start < offset : start <= offset) return { node, offset: offset - start }
  }
  return { node: nodes[0]!.node, offset: 0 }
}

/**
 * Every match of `query` in the rendered text under `root`, in document order,
 * as live Ranges. Text that isn't rendered (display:none, visibility:hidden,
 * inert) is skipped, as are form-field values, which aren't text nodes, and
 * subtrees marked with FIND_IGNORE_ATTRIBUTE.
 */
export function findTextRanges(root: Node, query: string): Range[] {
  const pattern = queryPattern(query)
  if (!pattern) return []
  const doc = root.ownerDocument ?? (root as Document)

  const visible = new Map<Element, boolean>()
  const isVisible = (el: Element): boolean => {
    let result = visible.get(el)
    if (result === undefined) {
      // Missing in jsdom; every rendered element passes there.
      result =
        typeof el.checkVisibility === "function"
          ? el.checkVisibility({ visibilityProperty: true })
          : true
      visible.set(el, result)
    }
    return result
  }
  const containers = new Map<Element, Element | null>()
  const containerOf = (el: Element): Element | null => {
    let container = containers.get(el)
    if (container === undefined) {
      container = el.closest(BLOCK_SELECTOR)
      containers.set(el, container)
    }
    return container
  }

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      const el = node as Element
      if (
        SKIP_TAGS.has(el.tagName) ||
        el.hasAttribute("inert") ||
        el.hasAttribute(FIND_IGNORE_ATTRIBUTE)
      ) {
        return NodeFilter.FILTER_REJECT
      }
      // Surface line breaks and block elements, which end the current run.
      return el.tagName === "BR" || el.matches(BLOCK_SELECTOR)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP
    },
  })

  const ranges: Range[] = []
  let run: Run = { text: "", nodes: [] }
  let runContainer: Element | null = null

  const flush = () => {
    if (run.text) {
      pattern.lastIndex = 0
      for (let m = pattern.exec(run.text); m; m = pattern.exec(run.text)) {
        const start = locate(run, m.index, false)
        const end = locate(run, m.index + m[0].length, true)
        const range = doc.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        ranges.push(range)
      }
    }
    run = { text: "", nodes: [] }
  }

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) {
      flush()
      continue
    }
    const text = node as Text
    const parent = text.parentElement
    if (!parent || !text.data || !isVisible(parent)) continue
    const container = containerOf(parent)
    if (container !== runContainer) {
      flush()
      runContainer = container
    }
    run.nodes.push({ node: text, start: run.text.length })
    run.text += text.data
  }
  flush()
  return ranges
}

/**
 * The index of the first match at or after `anchor`'s start, so a new search
 * or a rescan carries on from the current match. Falls back to the last match
 * (the nearest one) when `anchor` is past all of them.
 */
export function indexAtOrAfter(ranges: Range[], anchor: Range): number {
  if (ranges.length === 0) return -1
  for (const [i, range] of ranges.entries()) {
    try {
      if (range.compareBoundaryPoints(Range.START_TO_START, anchor) >= 0) return i
    } catch {
      // The anchor's node left the document.
      return 0
    }
  }
  return ranges.length - 1
}

/** A rectangle in window coordinates. A DOMRect is one. */
export interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * Whether `rect` is under `obstruction`: something that floats over the page,
 * such as the find bar, so a match there is on screen but hidden.
 */
function covered(rect: Box, obstruction: Box | undefined): boolean {
  if (
    !obstruction ||
    obstruction.bottom <= obstruction.top ||
    obstruction.right <= obstruction.left
  )
    return false
  return (
    rect.top < obstruction.bottom &&
    rect.bottom > obstruction.top &&
    rect.left < obstruction.right &&
    rect.right > obstruction.left
  )
}

/**
 * The part of the window where `el`'s content can show: the viewport, cut
 * down by every ancestor that clips its overflow (the runbook and log boxes
 * scroll on their own).
 */
function visibleArea(el: Element | null, cache: Map<Element, Box>): Box {
  if (!el) {
    const view = document.documentElement
    return {
      top: 0,
      left: 0,
      bottom: window.innerHeight || view.clientHeight,
      right: window.innerWidth || view.clientWidth,
    }
  }
  const cached = cache.get(el)
  if (cached) return cached
  const outer = visibleArea(el.parentElement, cache)
  let area = outer
  const style = getComputedStyle(el)
  if (style.overflowX !== "visible" || style.overflowY !== "visible") {
    const box = el.getBoundingClientRect()
    area = {
      top: Math.max(outer.top, box.top + el.clientTop),
      left: Math.max(outer.left, box.left + el.clientLeft),
      bottom: Math.min(outer.bottom, box.top + el.clientTop + el.clientHeight),
      right: Math.min(outer.right, box.left + el.clientLeft + el.clientWidth),
    }
  }
  cache.set(el, area)
  return area
}

/** Range.getBoundingClientRect, which jsdom doesn't implement. */
function rectOf(range: Range): DOMRect | null {
  return typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null
}

/**
 * Where a new search starts: the first match that is in view or below it,
 * else the first match. Starting from the top would pull the reader of a long
 * runbook away from where they are. A match under `obstruction` (the find
 * bar) gives way to the next match when that one is on screen, so the search
 * starts on a match the reader can see without the page moving.
 */
export function firstMatchInView(ranges: Range[], obstruction?: Box): number {
  if (ranges.length === 0) return -1
  const cache = new Map<Element, Box>()
  let hidden = -1
  for (const [i, range] of ranges.entries()) {
    const rect = rectOf(range)
    if (!rect) return 0
    const area = visibleArea(range.startContainer.parentElement, cache)
    if (rect.bottom <= area.top) continue
    if (!covered(rect, obstruction)) return hidden >= 0 && rect.top >= area.bottom ? hidden : i
    if (hidden < 0) hidden = i
  }
  return Math.max(hidden, 0)
}

/** Whether a scroll container scrolls along `axis`. */
function scrolls(el: Element, axis: "x" | "y"): boolean {
  const style = getComputedStyle(el)
  const overflow = axis === "x" ? style.overflowX : style.overflowY
  if (overflow !== "auto" && overflow !== "scroll") return false
  return axis === "x" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight
}

/**
 * Scroll `range` into the middle of every scroll container it sits in, but
 * only where it is out of view or under `obstruction` (the find bar, which
 * floats over the page), so stepping between matches on screen doesn't move
 * the page. Works on the range itself, not its element, so a match far along
 * a long log line scrolls into view horizontally too.
 */
export function scrollRangeIntoView(range: Range, obstruction?: Box): void {
  const parent = range.startContainer.parentElement
  if (!rectOf(range)) {
    parent?.scrollIntoView({ block: "center", inline: "nearest" })
    return
  }
  for (let el = parent; el; el = el.parentElement) {
    const scrollY = scrolls(el, "y")
    const scrollX = scrolls(el, "x")
    if (!scrollY && !scrollX) continue
    const rect = range.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const top = box.top + el.clientTop
    const left = box.left + el.clientLeft
    if (
      scrollY &&
      (rect.top < top || rect.bottom > top + el.clientHeight || covered(rect, obstruction))
    ) {
      el.scrollTop += (rect.top + rect.bottom) / 2 - (top + el.clientHeight / 2)
    }
    if (scrollX && (rect.left < left || rect.right > left + el.clientWidth)) {
      el.scrollLeft += (rect.left + rect.right) / 2 - (left + el.clientWidth / 2)
    }
  }
  const rect = range.getBoundingClientRect()
  if (rect.top < 0 || rect.bottom > window.innerHeight || covered(rect, obstruction)) {
    window.scrollBy({ top: (rect.top + rect.bottom) / 2 - window.innerHeight / 2 })
  }
}

/** The page's highlight registry, when the Custom Highlight API exists (not in jsdom). */
function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function"
    ? CSS.highlights
    : null
}

/** Paint every match, and the current one on top of the rest. */
export function paintHighlights(ranges: Range[], current: number): void {
  const registry = highlightRegistry()
  if (!registry) return
  // add() one at a time: spreading thousands of ranges into the constructor
  // can exceed the argument limit.
  const all = new Highlight()
  for (const range of ranges) all.add(range)
  const active = new Highlight()
  const currentRange = ranges[current]
  if (currentRange) active.add(currentRange)
  active.priority = 1
  registry.set(FIND_MATCH_HIGHLIGHT, all)
  registry.set(FIND_ACTIVE_HIGHLIGHT, active)
}

export function clearHighlights(): void {
  const registry = highlightRegistry()
  registry?.delete(FIND_MATCH_HIGHLIGHT)
  registry?.delete(FIND_ACTIVE_HIGHLIGHT)
}
