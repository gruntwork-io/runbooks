import { ChevronDown, ChevronRight, Database, Copy, Check } from "lucide-react"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copyTextToClipboard } from "@/lib/utils"

interface ViewOutputsProps {
  outputs: Record<string, string> | null
  autoOpen?: boolean
}

export function ViewOutputs({ 
  outputs, 
  autoOpen = false,
}: ViewOutputsProps) {
  const [showOutputs, setShowOutputs] = useState(autoOpen)
  const [copied, setCopied] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Update showOutputs when autoOpen changes
  useEffect(() => {
    if (autoOpen) {
      setShowOutputs(true)
    }
  }, [autoOpen])

  // Get outputs as JSON string for copying
  const getOutputsJson = () => {
    return JSON.stringify(outputs || {}, null, 2)
  }

  // Handle copy to clipboard (full JSON)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent toggle
    const jsonStr = getOutputsJson()
    const ok = await copyTextToClipboard(jsonStr)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Handle copy individual value
  const handleCopyValue = async (key: string, value: string) => {
    const ok = await copyTextToClipboard(value)
    if (ok) {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    }
  }

  const hasOutputs = outputs && Object.keys(outputs).length > 0
  const outputCount = outputs ? Object.keys(outputs).length : 0

  // Don't render if there are no outputs
  if (!hasOutputs) {
    return null
  }

  return (
    <div className="border border-gray-200 rounded-sm">
      
      {/* Toggle button with Copy action */}
      <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors">
        <button
          onClick={() => setShowOutputs(!showOutputs)}
          className="flex items-center gap-2 text-left cursor-pointer flex-1"
        >
          {showOutputs ? (
            <ChevronDown className="size-4 text-gray-500" />
          ) : (
            <ChevronRight className="size-4 text-gray-500" />
          )}
          <Database className="size-4 text-gray-600" />
          <span className="text-sm text-gray-700">View Outputs ({outputCount})</span>
        </button>

        {/* Copy Button */}
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-6 px-2 text-gray-500 hover:text-gray-700 gap-1"
            >
              {copied ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span className="text-xs">Copy JSON</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{copied ? "Copied!" : "Copy outputs as JSON"}</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Outputs Table */}
      {showOutputs && (
        <div className="border-t border-gray-200 p-3 bg-gray-50 max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1 px-2 font-medium text-gray-600 w-1/3">Name</th>
                <th className="text-left py-1 px-2 font-medium text-gray-600">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(outputs || {}).map(([key, value]) => (
                <tr key={key} className="border-b border-gray-100 last:border-0">
                  <td className="py-1.5 px-2 font-mono text-xs text-gray-800">{key}</td>
                  <td className="py-1.5 px-2 font-mono text-xs text-gray-600">
                    <div className="flex items-center justify-between gap-2">
                      <span className="break-all">
                        {value.length > 100 ? (
                          <Tooltip delayDuration={350}>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">
                                {value.substring(0, 100)}...
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-md">
                              <pre className="text-xs whitespace-pre-wrap break-all">{value}</pre>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          value
                        )}
                      </span>
                      <button
                        onClick={() => handleCopyValue(key, value)}
                        className="shrink-0 p-1 text-gray-400 hover:text-gray-600 cursor-pointer"
                      >
                        {copiedKey === key ? (
                          <Check className="size-3.5 text-green-600" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
