import { ChevronDown, ChevronRight, SquareTerminal, Copy, Check, Download, WrapText, FileText } from "lucide-react"
import { useState, useEffect, useRef } from "react"
import type { ExecutionStatus } from "../types"
import { TerminalText } from "@/components/shared/TerminalText"
import type { LogEntry } from "@/hooks/useApiExec"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
  const { didCopy: copied, copy: copyLogs } = useCopyToClipboard(2000)
  const { didCopy: pathCopied, copy: copyPath } = useCopyToClipboard(2000)
  // Default to no-wrap: long log lines scroll horizontally rather than wrap.
  const [wrap, setWrap] = useState(false)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const userHasScrolledUp = useRef(false)

  useEffect(() => {
    if (autoOpen) {
      setShowLogs(true)
    }
  }, [autoOpen])

  // Scroll to bottom when logs panel opens or new logs arrive
  useEffect(() => {
    if (showLogs && logContainerRef.current && !userHasScrolledUp.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [showLogs, logs])

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

  return (
    <div className="border border-border rounded-sm">
      {/* Toggle button with Copy/Download actions */}
      <div className="flex items-center justify-between px-3 py-2 hover:bg-accent transition-colors">
        <button
          onClick={() => { setShowLogs(!showLogs); userHasScrolledUp.current = false }}
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
        {(hasLogs || logFilePath) && (
          <div className="flex items-center gap-1">
            {/* Copy log path — only when a file path is available */}
            {logFilePath && (
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCopyPath}
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
                  onClick={(e) => { e.stopPropagation(); setWrap(w => !w) }}
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
                  onClick={handleCopy}
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
                <DropdownMenuItem onClick={handleDownloadRaw}>
                  Raw Logs (.log)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDownloadJson}>
                  Structured Logs (.json)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </>
            )}
          </div>
        )}
      </div>

      {/* Logs — terminal-style display kept dark across both themes for
          readability of ANSI-colored output, matching how shells render. */}
      {showLogs && (
        <div
          ref={logContainerRef}
          onScroll={() => {
            const el = logContainerRef.current
            if (!el) return
            // Consider "at bottom" if within 32px of the end
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
            userHasScrolledUp.current = !atBottom
          }}
          className={`border-t border-border p-3 bg-gray-900 max-h-64 overflow-y-auto ${wrap ? '' : 'overflow-x-auto'}`}
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
      )}
    </div>
  )
}

