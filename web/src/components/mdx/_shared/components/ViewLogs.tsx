import { ChevronDown, ChevronRight, SquareTerminal, Copy, Check, Download } from "lucide-react"
import { useState, useEffect } from "react"
import type { ExecutionStatus } from "../types"
import { LinkifiedText } from "@/components/shared/LinkifiedText"
import type { LogEntry } from "@/hooks/useApiExec"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { copyTextToClipboard } from "@/lib/utils"
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
}

export function ViewLogs({ 
  logs, 
  status, 
  autoOpen = false,
  blockId,
}: ViewLogsProps) {
  const [showLogs, setShowLogs] = useState(autoOpen)
  const [copied, setCopied] = useState(false)

  // Update showLogs when autoOpen changes
  useEffect(() => {
    if (autoOpen) {
      setShowLogs(true)
    }
  }, [autoOpen])

  // Get plain text logs with ANSI codes stripped
  const getPlainTextLogs = () => {
    return logs.map(log => stripAnsi(log.line)).join('\n')
  }

  // Handle copy to clipboard
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent toggle
    const plainText = getPlainTextLogs()
    const ok = await copyTextToClipboard(plainText)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
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
    <div className="border border-gray-200 rounded-sm">
      
      {/* Toggle button with Copy/Download actions */}
      <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors">
        <button
          onClick={() => setShowLogs(!showLogs)}
          className="flex items-center gap-2 text-left cursor-pointer flex-1"
        >
          {showLogs ? (
            <ChevronDown className="size-4 text-gray-500" />
          ) : (
            <ChevronRight className="size-4 text-gray-500" />
          )}
          <SquareTerminal className="size-4 text-gray-600" />
          <span className="text-sm text-gray-700">View Logs</span>
        </button>

        {/* Copy and Download buttons - only show when there are logs */}
        {hasLogs && (
          <div className="flex items-center gap-1">
            {/* Copy Button */}
            <Tooltip delayDuration={350}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopy}
                  className="h-6 w-6 text-gray-500 hover:text-gray-700"
                >
                  {copied ? (
                    <Check className="size-3.5 text-green-600" />
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
                  className="h-6 px-2 text-gray-500 hover:text-gray-700 gap-1"
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
          </div>
        )}
      </div>

      {/* Logs */}
      {showLogs && (
        <div className="border-t border-gray-200 p-3 bg-gray-900 max-h-64 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-sm text-gray-400 italic">
              No logs yet. Click to start the execution.
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((log, index) => (
                <div key={index} className="text-xs font-mono text-gray-100">
                  <span className="text-gray-400 mr-2">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <LinkifiedText text={log.line} />
                </div>
              ))}
              {status === 'running' && (
                <div className="text-xs font-mono text-gray-400 animate-pulse">
                  Running...
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

