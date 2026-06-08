import { ChevronDown, ChevronRight, SquareTerminal, Copy, Check, Download, WrapText, FileText, Maximize2, Minimize2 } from "lucide-react"
import { useState, useEffect, useRef } from "react"
import type { ExecutionStatus } from "../types"
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
  stripAnsi,
  parseLogsToStructured,
  downloadFile,
  generateLogFilename,
} from "@/lib/logs"

interface ViewLogsProps {
  logs: LogEntry[]
  status: ExecutionStatus
  autoOpen?: boolean
  blockId: string
  /** Absolute path to the on-disk log file, when one is available (e.g. desktop runs). */
  logFilePath?: string | null
}

export function ViewLogs({
  logs,
  status,
  autoOpen = false,
  blockId,
  logFilePath,
}: ViewLogsProps) {
  const [showLogs, setShowLogs] = useState(autoOpen)
  // Whether the logs are blown up into a full-screen overlay.
  const [maximized, setMaximized] = useState(false)
  const { didCopy: copied, copy: copyLogs } = useCopyToClipboard(2000)
  const { didCopy: pathCopied, copy: copyPath } = useCopyToClipboard(2000)
  // Default to no-wrap: long log lines scroll horizontally rather than wrap.
  const [wrap, setWrap] = useState(false)

  useEffect(() => {
    if (autoOpen) {
      setShowLogs(true)
    }
  }, [autoOpen])

  // Get plain text logs with ANSI codes stripped
  const getPlainTextLogs = () => {
    return logs.map(log => stripAnsi(log.line)).join('\n')
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

  // Handle download raw logs
  const handleDownloadRaw = () => {
    const plainText = getPlainTextLogs()
    const filename = generateLogFilename(blockId, 'log')
    downloadFile(plainText, filename, 'text/plain')
  }

  // Handle download structured JSON logs
  const handleDownloadJson = () => {
    const structured = parseLogsToStructured(logs, blockId)
    const json = JSON.stringify(structured, null, 2)
    const filename = generateLogFilename(blockId, 'json')
    downloadFile(json, filename, 'application/json')
  }

  const hasLogs = logs.length > 0

  // Copy / wrap / download controls shared between the inline header and the
  // maximized overlay so both stay in sync.
  const actions = (
    <LogActions
      hasLogs={hasLogs}
      logFilePath={logFilePath}
      pathCopied={pathCopied}
      onCopyPath={handleCopyPath}
      wrap={wrap}
      onToggleWrap={() => setWrap(w => !w)}
      copied={copied}
      onCopy={handleCopy}
      onDownloadRaw={handleDownloadRaw}
      onDownloadJson={handleDownloadJson}
    />
  )

  return (
    <div className="border border-border rounded-sm">
      {/* Toggle button with Copy/Download actions */}
      <div className="flex items-center justify-between px-3 py-2 hover:bg-accent transition-colors">
        <button
          onClick={() => { setShowLogs(!showLogs) }}
          className="flex items-center gap-2 text-left cursor-pointer flex-1"
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
        {(hasLogs || logFilePath || status === 'running') && (
          <div className="flex items-center gap-1">
            {actions}

            {/* Maximize — blow the logs up into a full-screen overlay. Also
                available while a run is streaming but hasn't emitted output yet. */}
            {(hasLogs || status === 'running') && (
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Maximize logs"
                    onClick={(e) => { e.stopPropagation(); setMaximized(true) }}
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

      {/* Logs — terminal-style display kept dark across both themes for
          readability of ANSI-colored output, matching how shells render. */}
      {showLogs && (
        <LogScroll
          logs={logs}
          status={status}
          wrap={wrap}
          className={`border-t border-border p-3 bg-gray-900 max-h-64 overflow-y-auto ${wrap ? '' : 'overflow-x-auto'}`}
        />
      )}

      {/* Maximized overlay — the same logs filling (nearly) the whole screen.
          Clicking the minimize button, the close affordance, pressing Escape,
          or clicking outside the panel restores the inline size. */}
      <Dialog open={maximized} onOpenChange={setMaximized}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
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
                    onClick={() => setMaximized(false)}
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

          <LogScroll
            logs={logs}
            status={status}
            wrap={wrap}
            className={`flex-1 min-h-0 p-3 bg-gray-900 overflow-y-auto ${wrap ? '' : 'overflow-x-auto'}`}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Scrollable, terminal-style log body. Auto-scrolls to the newest line as logs
 * arrive unless the user has scrolled up to read earlier output. Self-contained
 * (owns its scroll refs) so it can be reused for both the inline tail and the
 * maximized overlay without sharing state.
 */
function LogScroll({
  logs,
  status,
  wrap,
  className,
}: {
  logs: LogEntry[]
  status: ExecutionStatus
  wrap: boolean
  className: string
}) {
  const logContainerRef = useRef<HTMLDivElement>(null)
  const userHasScrolledUp = useRef(false)

  // Scroll to bottom on mount and as new logs arrive (unless the user scrolled up).
  useEffect(() => {
    if (logContainerRef.current && !userHasScrolledUp.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div
      ref={logContainerRef}
      onScroll={() => {
        const el = logContainerRef.current
        if (!el) return
        // Consider "at bottom" if within 32px of the end
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
        userHasScrolledUp.current = !atBottom
      }}
      className={className}
    >
      {logs.length > 0 && (
        <div className="space-y-1">
          {logs.map((log, index) => (
            <div
              key={`${log.timestamp}-${index}`}
              className={`text-xs font-mono text-gray-100 ${wrap ? '' : 'whitespace-nowrap'}`}
            >
              <span className="text-gray-400 mr-2">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <TerminalText text={log.line} wrap={wrap} />
            </div>
          ))}
        </div>
      )}
      {status === 'running' && (
        <div className="text-xs font-mono text-gray-400 animate-pulse">
          Running...
        </div>
      )}
      {logs.length === 0 && status !== 'running' && (
        <div className="text-sm text-gray-400 italic">
          No logs yet.
        </div>
      )}
    </div>
  )
}

/**
 * Copy-path / wrap / copy / download controls for a log view. Stateless: all
 * state and handlers live in the parent so the inline header and the maximized
 * overlay render identical, in-sync controls.
 */
function LogActions({
  hasLogs,
  logFilePath,
  pathCopied,
  onCopyPath,
  wrap,
  onToggleWrap,
  copied,
  onCopy,
  onDownloadRaw,
  onDownloadJson,
}: {
  hasLogs: boolean
  logFilePath?: string | null
  pathCopied: boolean
  onCopyPath: (e: React.MouseEvent) => void
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

      {hasLogs && (
        <>
          {/* Wrap toggle */}
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-pressed={wrap}
                aria-label={wrap ? "Disable line wrap" : "Enable line wrap"}
                onClick={(e) => { e.stopPropagation(); onToggleWrap() }}
                className={`h-6 w-6 hover:text-foreground ${wrap ? 'text-foreground bg-accent' : 'text-muted-foreground'}`}
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
              <DropdownMenuItem onClick={onDownloadRaw}>
                Raw Logs (.log)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDownloadJson}>
                Structured Logs (.json)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </>
  )
}
