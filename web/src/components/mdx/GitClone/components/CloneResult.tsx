import { CheckCircle, FolderOpen, Copy, Check } from "lucide-react"
import { useState, useCallback } from "react"
import { copyTextToClipboard } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { CloneResult } from "../types"

interface CloneResultDisplayProps {
  result: CloneResult
  onCloneAgain: () => void
}

export function CloneResultDisplay({ result, onCloneAgain }: CloneResultDisplayProps) {
  const [copiedRelative, setCopiedRelative] = useState(false)
  const [copiedAbsolute, setCopiedAbsolute] = useState(false)

  const handleCopyRelative = useCallback(async () => {
    const ok = await copyTextToClipboard(result.relativePath)
    if (ok) {
      setCopiedRelative(true)
      setTimeout(() => setCopiedRelative(false), 2000)
    }
  }, [result.relativePath])

  const handleCopyAbsolute = useCallback(async () => {
    const ok = await copyTextToClipboard(result.absolutePath)
    if (ok) {
      setCopiedAbsolute(true)
      setTimeout(() => setCopiedAbsolute(false), 2000)
    }
  }, [result.absolutePath])

  return (
    <div className="space-y-3">
      {/* Success panel */}
      <div className="bg-success-muted border border-success/30 rounded-md p-4 space-y-2">
        <div className="flex items-center gap-2 text-success font-medium">
          <CheckCircle className="size-5 text-success" />
          Clone complete
        </div>

        <div className="flex items-center gap-2 text-success">
          <FolderOpen className="size-4 text-success" />
          <span>Downloaded {result.fileCount} files</span>
        </div>

        <div className="space-y-1">
          <span className="text-sm font-medium text-success">Local path:</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-success">Relative:</span>
            <code className="text-sm bg-success-muted px-1.5 py-0.5 rounded font-mono text-success">
              {result.relativePath}
            </code>
            <button
              onClick={handleCopyRelative}
              className="shrink-0 p-0.5 text-success hover:text-success cursor-pointer"
            >
              {copiedRelative ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-success">Absolute:</span>
            <code className="text-sm bg-success-muted px-1.5 py-0.5 rounded font-mono text-success">
              {result.absolutePath}
            </code>
            <button
              onClick={handleCopyAbsolute}
              className="shrink-0 p-0.5 text-success hover:text-success cursor-pointer"
            >
              {copiedAbsolute ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Clone again button */}
      <Button
        variant="outline"
        size="sm"
        onClick={onCloneAgain}
        className="text-muted-foreground"
      >
        Clone again
      </Button>
    </div>
  )
}
