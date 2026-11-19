import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  SquareTerminal,
  Copy,
  Check,
  Download,
  WrapText,
  FileText,
  Maximize2,
  Minimize2,
  Search,
  Sparkles,
} from "lucide-react"
import {
  useState,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useContext,
  type ReactNode,
  type Ref,
} from "react"
import type { ExecutionStatus } from "../types"
import { buildLlmPrompt } from "../lib/llmPrompt"
import { LogSearchBar, type LogSearchOption } from "./LogSearchBar"
import { RunbookContext } from "@/contexts/RunbookContext"
import { TerminalText } from "@/components/shared/TerminalText"
import type { LogEntry } from "@/hooks/useApiExec"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import {
  FIND_COMMAND_EVENT,
  FIND_IGNORE_ATTRIBUTE,
  queryPattern,
  scrollRangeIntoView,
  visibleArea,
  type FindCommand,
} from "@/lib/findInPage"
import {
  clearLogMatches,
  findLogMatches,
  matchAtOrAfter,
  matchingLines,
  matchMarks,
  paintLogMatches,
  rangesIn,
  startMatch,
  type LineSpan,
  type LogMatch,
  type LogPosition,
} from "@/lib/logSearch"
import {
  stripAnsi,
  shownText,
  parseLogsToStructured,
  downloadFile,
  generateLogFilename,
} from "@/lib/logs"
import { formatShortcut } from "@/lib/platform"
import { cn } from "@/lib/utils"
import "./ViewLogs.css"

/** Leaves the log view's own text (timestamps, counts, buttons) out of find in page. */
const findIgnore = { [FIND_IGNORE_ATTRIBUTE]: "" }

/** A log's search, shared by its inline and maximized views. */
interface LogFind {
  open: boolean
  query: string
  matchCase: boolean
  regex: boolean
  onlyMatching: boolean
  /** The last query that parsed, with its options: an invalid regex leaves it in place. */
  pattern: RegExp | null
  /** The query is a regular expression that doesn't parse. */
  invalid: boolean
  /** Where the current match is. Null starts the next search where the reader is. */
  anchor: LogPosition | null
}

const NO_SEARCH: LogFind = {
  open: false,
  query: "",
  matchCase: false,
  regex: false,
  onlyMatching: false,
  pattern: null,
  invalid: false,
  anchor: null,
}

/** What a log view's search shows. */
interface ViewSearch {
  /** Null while the search is closed or has no query. */
  pattern: RegExp | null
  matches: LogMatch[]
  /** The current match's index, -1 for none. */
  current: number
  /** Only the matching lines are shown. */
  filtering: boolean
}

/** What ViewLogs asks of a rendered log view. */
interface LogViewHandle {
  /** The first and last lines on screen, or null when none are. */
  visibleLines: () => LineSpan | null
  /** Scroll match `index` into view. */
  reveal: (index: number) => void
  /** Focus the log body. */
  focus: () => void
}

interface ViewLogsProps {
  logs: LogEntry[]
  status: ExecutionStatus
  autoOpen?: boolean
  blockId: string
  /** Absolute path to the on-disk log file, when one is available (e.g. desktop runs). */
  logFilePath?: string | null
}

export function ViewLogs({ logs, status, autoOpen = false, blockId, logFilePath }: ViewLogsProps) {
  const [showLogs, setShowLogs] = useState(autoOpen)
  // Whether the logs are blown up into a full-screen overlay.
  const [maximized, setMaximized] = useState(false)
  const { didCopy: copied, copy: copyLogs } = useCopyToClipboard(2000)
  const { didCopy: pathCopied, copy: copyPath } = useCopyToClipboard(2000)
  const { didCopy: promptCopied, copy: copyPrompt } = useCopyToClipboard(2000)
  // Read the raw context rather than useRunbookContext() (which throws) so the
  // log view still renders outside a provider; the prompt then falls back to a
  // generic runbook description.
  const runbook = useContext(RunbookContext)
  // Default to no-wrap: long log lines scroll horizontally rather than wrap.
  const [wrap, setWrap] = useState(false)

  // Search in the logs. Bumping focusRequest focuses the search input, and
  // bumping revealRequest scrolls the current match into view, once the
  // views have rendered the change that asked for it.
  const [find, setFind] = useState<LogFind>(NO_SEARCH)
  const [focusRequest, setFocusRequest] = useState(0)
  const [revealRequest, setRevealRequest] = useState(0)
  const handledFocus = useRef(0)
  const handledReveal = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inlineView = useRef<LogViewHandle>(null)
  const maximizedView = useRef<LogViewHandle>(null)
  const inlineInput = useRef<HTMLInputElement>(null)
  const maximizedInput = useRef<HTMLInputElement>(null)
  const maximizeButton = useRef<HTMLButtonElement>(null)

  const [prevAutoOpen, setPrevAutoOpen] = useState(autoOpen)
  if (autoOpen !== prevAutoOpen) {
    setPrevAutoOpen(autoOpen)
    if (autoOpen) {
      setShowLogs(true)
    }
  }

  const pattern = find.open ? find.pattern : null
  const matches = findLogMatches(logs, pattern)
  // Without an anchor, the newest match, at the end where a log view opens.
  const current =
    matches.length === 0
      ? -1
      : find.anchor
        ? matchAtOrAfter(matches, find.anchor)
        : matches.length - 1
  const search: ViewSearch = {
    pattern,
    matches,
    current,
    filtering: pattern !== null && find.onlyMatching,
  }

  /** The log view on screen: the maximized one while it is open. */
  const activeView = () => (maximized ? maximizedView : inlineView).current

  /**
   * Run `next`'s query. The current match carries on from where it was;
   * without one, the search starts on the first match on screen, else the
   * closest one above.
   */
  const runSearch = (next: LogFind) => {
    let nextPattern: RegExp | null
    try {
      nextPattern = queryPattern(next.query, next)
    } catch {
      // Keep the last query that parsed, and its matches, until this one does.
      setFind({ ...next, invalid: true })
      return
    }
    const found = findLogMatches(logs, nextPattern)
    const index = next.anchor
      ? matchAtOrAfter(found, next.anchor)
      : startMatch(found, activeView()?.visibleLines() ?? null)
    const match = found[index]
    setFind({
      ...next,
      pattern: nextPattern,
      invalid: false,
      anchor: match ? { line: match.line, start: match.start } : null,
    })
    setRevealRequest((n) => n + 1)
  }

  /** Open the search, expanding the logs, or focus its input again, like Find…. */
  const openSearch = () => {
    if (!find.open) {
      setShowLogs(true)
      // Search again for the kept query, starting where the reader is.
      runSearch({ ...find, open: true, anchor: null })
    }
    setFocusRequest((n) => n + 1)
  }

  /** Close the search, keeping its query and options for next time. */
  const closeSearch = (returnFocus: boolean) => {
    if (!find.open) return
    setFind({ ...find, open: false, anchor: null })
    if (returnFocus) activeView()?.focus()
  }

  const step = (delta: 1 | -1) => {
    if (matches.length === 0) return
    const index =
      current < 0
        ? delta > 0
          ? 0
          : matches.length - 1
        : (current + delta + matches.length) % matches.length
    // matches is non-empty and index is reduced modulo its length.
    const match = matches[index]!
    setFind({ ...find, anchor: { line: match.line, start: match.start } })
    setRevealRequest((n) => n + 1)
  }

  const toggleOption = (option: LogSearchOption) => {
    if (option === "onlyMatching") {
      setFind({ ...find, onlyMatching: !find.onlyMatching })
      setRevealRequest((n) => n + 1)
    } else {
      runSearch({ ...find, [option]: !find[option] })
    }
  }

  const changeMaximized = (next: boolean) => {
    setMaximized(next)
    if (!find.open) return
    // The search carries over, so the view coming up shows it and its match.
    setShowLogs(true)
    setRevealRequest((n) => n + 1)
  }

  // Edit > Find…, Find Next and Find Previous come here, by way of the find
  // bar, while focus is in these logs: inline, or maximized, where the find
  // bar can't open over the dialog.
  const onFindCommand = useEffectEvent((event: Event) => {
    const target = event.target
    if (!(target instanceof Node)) return
    if (!rootRef.current?.contains(target) && !dialogRef.current?.contains(target)) return
    event.preventDefault()
    const { action } = (event as CustomEvent<FindCommand>).detail
    if (action === "open" || !find.open) openSearch()
    else step(action === "next" ? 1 : -1)
  })
  useEffect(() => {
    const listener = (event: Event) => onFindCommand(event)
    document.addEventListener(FIND_COMMAND_EVENT, listener)
    return () => document.removeEventListener(FIND_COMMAND_EVENT, listener)
  }, [])

  useLayoutEffect(() => {
    if (focusRequest === handledFocus.current) return
    handledFocus.current = focusRequest
    const input = (maximized ? maximizedInput : inlineInput).current
    input?.focus()
    input?.select()
  }, [focusRequest, maximized])

  // After the views' own layout effects, which keep a following log at its
  // end and map the matches onto its lines.
  useLayoutEffect(() => {
    if (revealRequest === handledReveal.current) return
    handledReveal.current = revealRequest
    if (current >= 0) (maximized ? maximizedView : inlineView).current?.reveal(current)
  }, [revealRequest, current, maximized])

  // Get plain text logs with ANSI codes stripped
  const getPlainTextLogs = () => {
    return logs.map((log) => stripAnsi(log.line)).join("\n")
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await copyLogs(getPlainTextLogs())
  }

  const handleCopyPath = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!logFilePath) return
    await copyPath(logFilePath)
  }

  const handleCopyPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await copyPrompt(
      buildLlmPrompt({
        blockId,
        status,
        runbookFilePath: runbook?.runbookFilePath,
        remoteSource: runbook?.remoteSource,
        logFilePath,
        logText: getPlainTextLogs(),
      }),
    )
  }

  // Handle download raw logs
  const handleDownloadRaw = () => {
    const plainText = getPlainTextLogs()
    const filename = generateLogFilename(blockId, "log")
    downloadFile(plainText, filename, "text/plain")
  }

  // Handle download structured JSON logs
  const handleDownloadJson = () => {
    const structured = parseLogsToStructured(logs, blockId)
    const json = JSON.stringify(structured, null, 2)
    const filename = generateLogFilename(blockId, "json")
    downloadFile(json, filename, "application/json")
  }

  const hasLogs = logs.length > 0

  // Search / copy / wrap / download controls shared between the inline
  // header and the maximized overlay so both stay in sync.
  const actions = (
    <LogActions
      hasLogs={hasLogs}
      logFilePath={logFilePath}
      pathCopied={pathCopied}
      onCopyPath={handleCopyPath}
      promptCopied={promptCopied}
      onCopyPrompt={handleCopyPrompt}
      searchOpen={find.open}
      onToggleSearch={() => (find.open ? closeSearch(false) : openSearch())}
      wrap={wrap}
      onToggleWrap={() => setWrap((w) => !w)}
      copied={copied}
      onCopy={handleCopy}
      onDownloadRaw={handleDownloadRaw}
      onDownloadJson={handleDownloadJson}
    />
  )

  const searchBar = {
    query: find.query,
    matchCase: find.matchCase,
    regex: find.regex,
    onlyMatching: find.onlyMatching,
    invalid: find.invalid,
    count: matches.length,
    current,
    onQueryChange: (query: string) => runSearch({ ...find, query }),
    onToggle: toggleOption,
    onStep: step,
    onClose: () => closeSearch(true),
  }

  return (
    <div
      ref={rootRef}
      // Escape closes the search. In maximized logs the dialog's own Escape
      // handler does it first, and marks the event handled.
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || !find.open) return
        e.preventDefault()
        closeSearch(true)
      }}
      className="border border-border rounded-sm"
    >
      {/* Toggle button with Copy/Download actions. The toggle is as tall as
          the actions, so the bar doesn't grow when they appear. */}
      <div className="flex items-center justify-between px-3 py-2 hover:bg-accent transition-colors">
        <button
          type="button"
          aria-expanded={showLogs}
          onClick={() => {
            if (showLogs) closeSearch(false)
            setShowLogs(!showLogs)
          }}
          className="flex items-center gap-2 text-left cursor-pointer flex-1 min-h-6"
        >
          {showLogs ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <SquareTerminal className="size-4 text-muted-foreground" />
          <span className="text-sm text-foreground">View Logs</span>
        </button>

        {/* Action buttons. The copy-path button appears whenever an on-disk
            log file exists (even before any output), so the file can be opened
            directly; the rest require logs to act on. */}
        {(hasLogs || logFilePath || status === "running") && (
          <div className="flex items-center gap-1">
            {actions}

            {/* Maximize — blow the logs up into a full-screen overlay. Also
                available while a run is streaming but hasn't emitted output yet. */}
            {(hasLogs || status === "running") && (
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <Button
                    ref={maximizeButton}
                    variant="ghost"
                    size="icon"
                    aria-label="Maximize logs"
                    onClick={(e) => {
                      e.stopPropagation()
                      changeMaximized(true)
                    }}
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  >
                    <Maximize2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Maximize logs</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {showLogs && find.open && (
        <LogSearchBar inputRef={inlineInput} className="border-t border-border" {...searchBar} />
      )}

      {/* Logs — terminal-style display kept dark across both themes for
          readability of ANSI-colored output, matching how shells render. */}
      {showLogs && (
        <LogScroll
          ref={inlineView}
          logs={logs}
          status={status}
          wrap={wrap}
          search={search}
          variant="inline"
        />
      )}

      {/* Maximized overlay — the same logs filling (nearly) the whole screen.
          Clicking the minimize button, the close affordance, pressing Escape,
          or clicking outside the panel restores the inline size. */}
      <Dialog open={maximized} onOpenChange={changeMaximized}>
        <DialogContent
          ref={dialogRef}
          showCloseButton={false}
          aria-describedby={undefined}
          // Focus the search when it's open, else the log body, so the keys
          // that scroll it work straight away.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            if (find.open) maximizedInput.current?.focus()
            else maximizedView.current?.focus()
          }}
          // The dialog has no trigger for Radix to return focus to, so return
          // it to the inline search, else to the button that maximized the
          // logs, keeping Find… and the keys on these logs.
          onCloseAutoFocus={(e) => {
            const target = find.open ? inlineInput.current : maximizeButton.current
            if (!target) return
            e.preventDefault()
            target.focus()
          }}
          // Escape closes the search before the logs.
          onEscapeKeyDown={(e) => {
            if (!find.open) return
            e.preventDefault()
            closeSearch(true)
          }}
          className="flex flex-col gap-0 p-0 overflow-hidden w-[95vw] max-w-[95vw] sm:max-w-[95vw] h-[90vh]"
        >
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              <SquareTerminal className="size-4 text-muted-foreground shrink-0" />
              <DialogTitle className="text-sm font-medium truncate">Logs — {blockId}</DialogTitle>
            </div>
            <div className="flex items-center gap-1">
              {actions}

              {/* Minimize — restore the inline log tail */}
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Minimize logs"
                    onClick={() => changeMaximized(false)}
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  >
                    <Minimize2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Minimize logs</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {find.open && (
            <LogSearchBar
              inputRef={maximizedInput}
              className="border-b border-border"
              {...searchBar}
            />
          )}

          <LogScroll
            ref={maximizedView}
            logs={logs}
            status={status}
            wrap={wrap}
            search={search}
            variant="maximized"
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A view within this many pixels of its end counts as at the end, and follows new lines. */
const END_SLACK = 32

const atEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < END_SLACK

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

/**
 * Scrollable, terminal-style log body. Auto-scrolls to the newest line as logs
 * arrive unless the user has scrolled up to read earlier output; Jump to top
 * and Jump to bottom buttons show when they would move it, and while a run
 * streams, the second counts the lines that arrived since the user scrolled
 * up. Self-contained (owns its scroll state) so it can be reused for both the
 * inline tail and the maximized overlay; the search comes from ViewLogs.
 */
function LogScroll({
  ref,
  logs,
  status,
  wrap,
  search,
  variant,
}: {
  ref: Ref<LogViewHandle>
  logs: LogEntry[]
  status: ExecutionStatus
  wrap: boolean
  search: ViewSearch
  variant: "inline" | "maximized"
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Whether new lines scroll the view to the end: until the user scrolls up.
  const following = useRef(true)
  // The match ranges painted in this view, one per match, null where a match
  // couldn't be found among the rendered lines.
  const rangesRef = useRef<(Range | null)[]>([])
  // Who painted this view's matches, for lib/logSearch.
  const [owner] = useState(() => ({}))
  const [showTop, setShowTop] = useState(false)
  const [showBottom, setShowBottom] = useState(false)
  // How many lines there were when the user scrolled away from the end.
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  // A new run starts its logs over.
  if (pausedAt !== null && logs.length < pausedAt) setPausedAt(logs.length)

  const { pattern, matches, current, filtering } = search

  // Scroll to the end on mount and as new logs arrive, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [logs, wrap, filtering])

  // Map the matches onto the rendered lines and paint them.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !pattern || matches.length === 0) {
      rangesRef.current = []
      clearLogMatches(owner)
      return
    }
    const lines = new Map<number, Element>()
    for (const line of el.querySelectorAll<HTMLElement>("[data-log-line]")) {
      lines.set(Number(line.dataset.logLine), line)
    }
    const ranges: (Range | null)[] = []
    for (let i = 0; i < matches.length;) {
      const { line } = matches[i]!
      let end = i
      while (matches[end]?.line === line) end++
      const lineMatches = matches.slice(i, end)
      const lineEl = lines.get(line)
      // line is a line of logs, since the matches came from them.
      ranges.push(
        ...(lineEl
          ? rangesIn(lineEl, shownText(logs[line]!.line), lineMatches)
          : lineMatches.map(() => null)),
      )
      i = end
    }
    rangesRef.current = ranges
    paintLogMatches(
      owner,
      ranges.filter((range) => range !== null),
      ranges[current] ?? null,
    )
  }, [owner, logs, pattern, matches, current, filtering, wrap])

  useEffect(() => () => clearLogMatches(owner), [owner])

  useImperativeHandle(ref, () => ({
    visibleLines: () => {
      const el = bodyRef.current
      if (!el) return null
      const area = visibleArea(el, new Map())
      let first = -1
      let last = -1
      for (const line of el.querySelectorAll<HTMLElement>("[data-log-line]")) {
        const rect = line.getBoundingClientRect()
        if (rect.bottom <= area.top) continue
        if (rect.top >= area.bottom) break
        last = Number(line.dataset.logLine)
        if (first < 0) first = last
      }
      return first < 0 ? null : { first, last }
    },
    reveal: (index) => {
      const el = bodyRef.current
      if (!el) return
      const range = rangesRef.current[index]
      const match = matches[index]
      if (range) scrollRangeIntoView(range)
      else if (match) {
        el.querySelector(`[data-log-line="${match.line}"]`)?.scrollIntoView({ block: "nearest" })
      }
      // Now, not on the scroll event: a line arriving first would scroll back.
      following.current = atEnd(el)
    },
    focus: () => bodyRef.current?.focus({ preventScroll: true }),
  }))

  /**
   * Show the jump buttons that would move the view, and count the new lines
   * from when it left the end.
   */
  const updateControls = (el: HTMLElement) => {
    const end = atEnd(el)
    setShowTop(el.scrollTop > el.clientHeight)
    setShowBottom(!end)
    if (end) setPausedAt(null)
    else if (pausedAt === null) setPausedAt(logs.length)
  }

  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    following.current = atEnd(el)
    updateControls(el)
  }

  // A change in size without a scroll, such as only matching lines leaving
  // nothing below, or a resized window: keep a following view at its end,
  // and the jump buttons up to date.
  const onResize = useEffectEvent(() => {
    const el = bodyRef.current
    if (!el) return
    if (following.current) el.scrollTop = el.scrollHeight
    else following.current = atEnd(el)
    updateControls(el)
  })
  useEffect(() => {
    const el = bodyRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => onResize())
    observer.observe(el)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  const jump = (to: "top" | "bottom") => {
    const el = bodyRef.current
    if (!el) return
    const top = to === "top" ? 0 : el.scrollHeight - el.clientHeight
    // Smooth over a few screens; further would take seconds. Never while a
    // run streams: a new line would scroll a view near its end back to it,
    // or move the end on.
    const smooth =
      Math.abs(top - el.scrollTop) <= el.clientHeight * 4 &&
      status !== "running" &&
      !prefersReducedMotion()
    following.current = to === "bottom"
    if (smooth && typeof el.scrollTo === "function") el.scrollTo({ top, behavior: "smooth" })
    else el.scrollTop = top
    // Without a scroll event when the view was already there.
    updateControls(el)
    el.focus({ preventScroll: true })
  }

  // With only matching lines shown, the indexes of those lines.
  const shown = filtering ? matchingLines(matches) : null
  const newLines = status === "running" && pausedAt !== null ? logs.length - pausedAt : 0
  const marks = pattern && !filtering ? matchMarks(matches, logs.length) : []
  const currentMatch = matches[current]
  const currentMark =
    currentMatch && marks.length > 0 ? (currentMatch.line + 0.5) / logs.length : null

  const renderLine = (index: number, gap: boolean) => {
    // index is a line of logs.
    const log = logs[index]!
    return (
      <div
        key={`${log.timestamp}-${index}`}
        data-log-line={index}
        className={cn(
          "text-xs font-mono text-gray-100",
          !wrap && "whitespace-nowrap",
          // Hidden lines above: a dashed rule.
          gap && "mt-1 border-t border-dashed border-gray-700 pt-2",
        )}
      >
        <span className="text-gray-400 mr-2" {...findIgnore}>
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
        <TerminalText text={log.line} wrap={wrap} />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "relative flex flex-col bg-gray-900",
        variant === "inline" ? "border-t border-border" : "min-h-0 flex-1",
      )}
    >
      {shown && (
        <div
          {...findIgnore}
          className="shrink-0 border-b border-gray-800 px-3 py-1.5 text-xs text-gray-400"
        >
          Showing {shown.length} of {logs.length} {logs.length === 1 ? "line" : "lines"}
        </div>
      )}
      <div
        ref={bodyRef}
        // Focusable, so Home, End and the arrow keys scroll it, and Find… knows
        // the logs have focus.
        tabIndex={0}
        role="region"
        aria-label="Log output"
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || e.altKey || e.shiftKey) return
          const to =
            e.key === "Home" || (e.metaKey && e.key === "ArrowUp")
              ? "top"
              : e.key === "End" || (e.metaKey && e.key === "ArrowDown")
                ? "bottom"
                : null
          if (!to) return
          e.preventDefault()
          jump(to)
        }}
        className={cn(
          "p-3 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          variant === "inline" ? "max-h-64" : "min-h-0 flex-1",
          !wrap && "overflow-x-auto",
        )}
      >
        <div ref={contentRef}>
          {logs.length > 0 && (
            <div className="space-y-1">
              {shown
                ? shown.map((index, k) => renderLine(index, k > 0 && index - shown[k - 1]! > 1))
                : logs.map((_, index) => renderLine(index, false))}
            </div>
          )}
          {shown?.length === 0 && logs.length > 0 && (
            <div className="text-sm text-gray-400 italic">No matching lines.</div>
          )}
          {status === "running" && (
            <div className="text-xs font-mono text-gray-400 animate-pulse">Running...</div>
          )}
          {logs.length === 0 && status !== "running" && (
            <div className="text-sm text-gray-400 italic">No logs yet.</div>
          )}
        </div>
      </div>

      {/* Where the matches fall in the whole log, along its right edge. */}
      {marks.length > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 right-0.5 bottom-0.5 w-2"
        >
          {marks.map((mark) => (
            <span
              key={mark}
              className="absolute right-0 -mt-px h-0.5 w-1.5 rounded-[1px] bg-yellow-300/90"
              style={{ top: `${mark * 100}%` }}
            />
          ))}
          {currentMark !== null && (
            <span
              className="absolute right-0 -mt-0.5 h-1 w-1.5 rounded-[1px] bg-orange-400"
              style={{ top: `${currentMark * 100}%` }}
            />
          )}
        </div>
      )}

      <div {...findIgnore} className="absolute right-4 bottom-3 flex flex-col items-end gap-1.5">
        {showTop && (
          <JumpButton label="Jump to top" shortcut="Home" onClick={() => jump("top")}>
            <ArrowUpToLine className="size-3.5" />
          </JumpButton>
        )}
        {showBottom &&
          (newLines > 0 ? (
            <JumpButton
              label={`Jump to bottom: ${newLines} new ${newLines === 1 ? "line" : "lines"}`}
              shortcut="End"
              pill
              onClick={() => jump("bottom")}
            >
              <ArrowDown className="size-3.5" />
              {newLines} new {newLines === 1 ? "line" : "lines"}
            </JumpButton>
          ) : (
            <JumpButton label="Jump to bottom" shortcut="End" onClick={() => jump("bottom")}>
              <ArrowDownToLine className="size-3.5" />
            </JumpButton>
          ))}
      </div>
    </div>
  )
}

/** A button floating in a log view's corner, styled for its dark background. */
function JumpButton({
  label,
  shortcut,
  pill = false,
  onClick,
  children,
}: {
  label: string
  shortcut: string
  pill?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (${shortcut})`}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1.5 text-xs font-medium shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pill
          ? "rounded-full bg-blue-600 pr-2.5 pl-2 text-white hover:bg-blue-700"
          : "rounded-md border border-gray-700 bg-gray-800/90 text-gray-200 hover:bg-gray-700",
      )}
    >
      {children}
    </button>
  )
}

/**
 * Copy-path / copy-prompt / search / wrap / copy / download controls for a
 * log view. Stateless: all state and handlers live in the parent so the inline
 * header and the maximized overlay render identical, in-sync controls.
 */
function LogActions({
  hasLogs,
  logFilePath,
  pathCopied,
  onCopyPath,
  promptCopied,
  onCopyPrompt,
  searchOpen,
  onToggleSearch,
  wrap,
  onToggleWrap,
  copied,
  onCopy,
  onDownloadRaw,
  onDownloadJson,
}: {
  hasLogs: boolean
  logFilePath?: string | null | undefined
  pathCopied: boolean
  onCopyPath: (e: React.MouseEvent) => void
  promptCopied: boolean
  onCopyPrompt: (e: React.MouseEvent) => void
  searchOpen: boolean
  onToggleSearch: () => void
  wrap: boolean
  onToggleWrap: () => void
  copied: boolean
  onCopy: (e: React.MouseEvent) => void
  onDownloadRaw: () => void
  onDownloadJson: () => void
}) {
  return (
    <>
      {/* Copy log path — only when a file path is available */}
      {logFilePath && (
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy log file path"
              onClick={onCopyPath}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              {pathCopied ? (
                <Check className="size-3.5 text-success" />
              ) : (
                <FileText className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{pathCopied ? "Copied!" : "Copy log file path"}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Copy prompt for LLM — points at the log file when there is one,
          otherwise inlines the most recent log lines */}
      {(logFilePath || hasLogs) && (
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy prompt for LLM"
              onClick={onCopyPrompt}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              {promptCopied ? (
                <Check className="size-3.5 text-success" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{promptCopied ? "Copied!" : "Copy prompt for LLM"}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {hasLogs && (
        <>
          {/* Search toggle — also opens a collapsed log */}
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-pressed={searchOpen}
                aria-label="Search logs"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleSearch()
                }}
                className={`h-6 w-6 hover:text-foreground ${searchOpen ? "text-foreground bg-accent" : "text-muted-foreground"}`}
              >
                <Search className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Search logs ({formatShortcut("F")})</p>
            </TooltipContent>
          </Tooltip>

          {/* Wrap toggle */}
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-pressed={wrap}
                aria-label={wrap ? "Disable line wrap" : "Enable line wrap"}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleWrap()
                }}
                className={`h-6 w-6 hover:text-foreground ${wrap ? "text-foreground bg-accent" : "text-muted-foreground"}`}
              >
                <WrapText className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{wrap ? "Disable line wrap" : "Enable line wrap"}</p>
            </TooltipContent>
          </Tooltip>

          {/* Copy Button */}
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy logs"
                onClick={onCopy}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copied ? "Copied!" : "Copy logs"}</p>
            </TooltipContent>
          </Tooltip>

          {/* Download Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-muted-foreground hover:text-foreground gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="size-3.5" />
                <span className="text-xs">Download Logs</span>
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDownloadRaw}>Raw Logs (.log)</DropdownMenuItem>
              <DropdownMenuItem onClick={onDownloadJson}>Structured Logs (.json)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </>
  )
}
