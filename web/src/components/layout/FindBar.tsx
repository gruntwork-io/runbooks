import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApi } from '@/contexts/ApiContext'
import {
  clearHighlights,
  findTextRanges,
  firstMatchInView,
  indexAtOrAfter,
  paintHighlights,
  scrollRangeIntoView,
} from '@/lib/findInPage'
import './FindBar.css'

/** How long a page change waits before the matches are counted again. */
const RESCAN_DELAY_MS = 150

/**
 * The find-in-page bar, opened by Edit > Find… (Cmd/Ctrl+F). It searches the
 * rendered page, highlights every match, and steps through them with Enter /
 * Shift+Enter, the buttons, or Edit > Find Next / Find Previous
 * (Cmd/Ctrl+G / Shift+Cmd/Ctrl+G). Escape closes it. See lib/findInPage for
 * why this doesn't use webContents.findInPage.
 */
export function FindBar() {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState({ count: 0, current: -1 })
  // Bumped by every Find…, so the input takes focus again while already open.
  const [focusRequest, setFocusRequest] = useState(0)

  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Mirrors of state for the menu listener and the MutationObserver.
  const openRef = useRef(false)
  const queryRef = useRef('')
  const rangesRef = useRef<Range[]>([])
  const currentRef = useRef(-1)
  // What had focus before the bar opened, to give it back on close.
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const show = useCallback((ranges: Range[], current: number) => {
    rangesRef.current = ranges
    currentRef.current = current
    paintHighlights(ranges, current)
    setResult({ count: ranges.length, current })
  }, [])

  /**
   * Search the page for `text`. The current match stays where it was, or on
   * the next match after it; without one, the search starts at the first
   * match in view. `scroll` brings that match into view, which a recount
   * after a page change doesn't do, so streaming logs don't move the page.
   */
  const search = useCallback((text: string, scroll: boolean) => {
    const anchor = rangesRef.current[currentRef.current]
    const ranges = findTextRanges(document.body, text)
    const current = anchor ? indexAtOrAfter(ranges, anchor) : firstMatchInView(ranges)
    show(ranges, current)
    if (scroll && current >= 0) scrollRangeIntoView(ranges[current])
  }, [show])

  const step = useCallback((delta: 1 | -1) => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const from = currentRef.current
    const current = from < 0 ? (delta > 0 ? 0 : ranges.length - 1) : (from + delta + ranges.length) % ranges.length
    show(ranges, current)
    scrollRangeIntoView(ranges[current])
  }, [show])

  const openBar = useCallback(() => {
    if (!openRef.current) {
      openRef.current = true
      const active = document.activeElement
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null
      setOpen(true)
    }
    setFocusRequest((n) => n + 1)
  }, [])

  // Keeps the query for the next Find…, like a browser.
  const close = useCallback(() => {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
    clearHighlights()
    rangesRef.current = []
    currentRef.current = -1
    setResult({ count: 0, current: -1 })
    const returnFocus = returnFocusRef.current
    returnFocusRef.current = null
    // Only while the bar has focus: the user may have clicked into the page since.
    if (returnFocus?.isConnected && barRef.current?.contains(document.activeElement)) {
      returnFocus.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => api.on('menu:find', ({ action }) => {
    if (action === 'open' || !openRef.current) openBar()
    else step(action === 'next' ? 1 : -1)
  }), [api, openBar, step])

  // Focus the input, with its text selected, on open and on every Find….
  useLayoutEffect(() => {
    if (!open) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
    // A modal dialog (such as maximized logs) keeps focus inside itself, so
    // the bar would sit unusable behind it.
    if (document.activeElement !== input) close()
  }, [open, focusRequest, close])

  // Search again for the kept query when the bar reopens.
  useEffect(() => {
    if (open && openRef.current && queryRef.current.trim()) search(queryRef.current, true)
  }, [open, search])

  // Recount as the page changes (logs stream in, blocks expand) while open.
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver((mutations) => {
      if (timer !== undefined || !queryRef.current.trim()) return
      // The bar's own count changing isn't a page change.
      const bar = barRef.current
      if (bar && mutations.every((m) => bar.contains(m.target))) return
      timer = setTimeout(() => {
        timer = undefined
        if (openRef.current) search(queryRef.current, false)
      }, RESCAN_DELAY_MS)
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'inert'],
    })
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [open, search])

  useEffect(() => clearHighlights, [])

  if (!open) return null

  const status = !query.trim()
    ? ''
    : result.count === 0
      ? 'No results'
      : `${result.current + 1} of ${result.count}`

  // Keep focus in the input when a button is clicked, so typing carries on.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const buttonClass = 'h-6 w-6 text-muted-foreground hover:text-foreground'

  return (
    // data-find-ignore leaves the bar's own text out of the search.
    <div
      ref={barRef}
      role="search"
      data-find-ignore=""
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        close()
      }}
      className="fixed top-18 right-4 z-50 flex items-center gap-1 rounded-md border border-border bg-popover py-1 pr-1 pl-2 text-popover-foreground shadow-md"
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in page"
        placeholder="Find in page"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          queryRef.current = e.target.value
          setQuery(e.target.value)
          search(e.target.value, true)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          step(e.shiftKey ? -1 : 1)
        }}
        className="w-48 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span role="status" className="min-w-16 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {status}
      </span>
      <div className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={result.count === 0}
        onMouseDown={keepFocus}
        onClick={() => step(-1)}
        className={buttonClass}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={result.count === 0}
        onMouseDown={keepFocus}
        onClick={() => step(1)}
        className={buttonClass}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close find bar"
        title="Close (Esc)"
        onMouseDown={keepFocus}
        onClick={close}
        className={buttonClass}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
