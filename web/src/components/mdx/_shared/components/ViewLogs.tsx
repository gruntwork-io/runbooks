import { ChevronDown, ChevronRight, SquareTerminal } from "lucide-react"
import { useState, useEffect } from "react"
import type { ExecutionStatus } from "../types"
import { LinkifiedText } from "@/components/shared/LinkifiedText"
import type { LogEntry } from "@/hooks/useApiExec"

interface ViewLogsProps {
  logs: LogEntry[]
  status: ExecutionStatus
  autoOpen?: boolean
}

export function ViewLogs({ 
  logs, 
  status, 
  autoOpen = false 
}: ViewLogsProps) {
  const [showLogs, setShowLogs] = useState(autoOpen)

  // Update showLogs when autoOpen changes
  useEffect(() => {
    if (autoOpen) {
      setShowLogs(true)
    }
  }, [autoOpen])

  return (
    <div className="border border-gray-200 rounded-sm">
      
      {/* Toggle button */}
      <button
        onClick={() => setShowLogs(!showLogs)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
      >
        {showLogs ? (
          <ChevronDown className="size-4 text-gray-500" />
        ) : (
          <ChevronRight className="size-4 text-gray-500" />
        )}
        <SquareTerminal className="size-4 text-gray-600" />
        <span className="text-sm text-gray-700">View Logs</span>
      </button>

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

