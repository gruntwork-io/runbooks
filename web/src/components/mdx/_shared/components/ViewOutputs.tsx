import { ChevronDown, ChevronRight, Database, Copy, Check } from "lucide-react"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copyTextToClipboard } from "@/lib/utils"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

/** Shown in place of a sensitive value. Fixed length, so it doesn't reveal the value's. */
const SENSITIVE_MASK = "••••••••"
/** Written in place of a sensitive value by Copy JSON. */
const REDACTED = "[REDACTED]"

interface ViewOutputsProps {
  outputs: Record<string, string> | null
  /** Keys whose values are masked on screen and redacted in Copy JSON. */
  sensitiveKeys?: readonly string[]
  autoOpen?: boolean
}

const NO_SENSITIVE_KEYS: readonly string[] = []

export function ViewOutputs({
  outputs,
  sensitiveKeys = NO_SENSITIVE_KEYS,
  autoOpen = false,
}: ViewOutputsProps) {
  const [showOutputs, setShowOutputs] = useState(autoOpen)
  const { didCopy: copied, copy: doCopy } = useCopyToClipboard(2000)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    if (autoOpen) {
      setShowOutputs(true)
    }
  }, [autoOpen])

  const isSensitive = (key: string) => sensitiveKeys.includes(key)
  const hasSensitive = Object.keys(outputs || {}).some(isSensitive)

  // Copy JSON is what gets pasted into bug reports, so it never carries a
  // sensitive value. The row's own copy button copies the real one.
  const getOutputsJson = () => {
    const shown = Object.fromEntries(
      Object.entries(outputs || {}).map(([key, value]) => [key, isSensitive(key) ? REDACTED : value]),
    )
    return JSON.stringify(shown, null, 2)
  }

  // Handle copy to clipboard (full JSON)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent toggle
    await doCopy(getOutputsJson())
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

  if (!hasOutputs) {
    return null
  }

  return (
    <div className="border border-border rounded-sm">

      {/* Toggle button with Copy action */}
      <div className="flex items-center justify-between px-3 py-2 hover:bg-accent transition-colors">
        <button
          onClick={() => setShowOutputs(!showOutputs)}
          className="flex items-center gap-2 text-left cursor-pointer flex-1"
        >
          {showOutputs ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <Database className="size-4 text-muted-foreground" />
          <span className="text-sm text-foreground">View Outputs ({outputCount})</span>
        </button>

        {/* Copy Button */}
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-6 px-2 text-muted-foreground hover:text-foreground gap-1"
            >
              {copied ? (
                <Check className="size-3.5 text-success" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span className="text-xs">Copy JSON</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>
              {copied
                ? "Copied!"
                : hasSensitive
                  ? "Copy outputs as JSON (sensitive values redacted)"
                  : "Copy outputs as JSON"}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Outputs Table */}
      {showOutputs && (
        <div className="border-t border-border p-3 bg-muted max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-1 px-2 font-medium text-muted-foreground w-1/3">Name</th>
                <th className="text-left py-1 px-2 font-medium text-muted-foreground">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(outputs || {}).map(([key, value]) => (
                <tr key={key} className="border-b border-border last:border-0">
                  <td className="py-1.5 px-2 font-mono text-xs text-foreground">{key}</td>
                  <td className="py-1.5 px-2 font-mono text-xs text-muted-foreground">
                    <div className="flex items-center justify-between gap-2">
                      <span className="break-all">
                        {isSensitive(key) ? (
                          <span title="Sensitive value hidden. The copy button copies it.">
                            <span aria-hidden="true">{SENSITIVE_MASK}</span>
                            <span className="sr-only">Sensitive value hidden</span>
                          </span>
                        ) : value.length > 100 ? (
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
                        aria-label={`Copy value of ${key}`}
                        className="shrink-0 p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        {copiedKey === key ? (
                          <Check className="size-3.5 text-success" />
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
