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
      <div className="bg-green-50 border border-green-200 rounded-md p-4 space-y-2">
        <div className="flex items-center gap-2 text-green-800 font-medium">
          <CheckCircle className="size-5 text-green-600" />
          Clone complete
        </div>

        <div className="flex items-center gap-2 text-green-700">
          <FolderOpen className="size-4 text-green-600" />
          <span>Downloaded {result.fileCount} files</span>
        </div>

        <div className="space-y-1">
          <span className="text-sm font-medium text-green-700">Local path:</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-green-600">Relative:</span>
            <code className="text-sm bg-green-100 px-1.5 py-0.5 rounded font-mono text-green-800">
              {result.relativePath}
            </code>
            <button
              onClick={handleCopyRelative}
              className="shrink-0 p-0.5 text-green-600 hover:text-green-800 cursor-pointer"
            >
              {copiedRelative ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-green-600">Absolute:</span>
            <code className="text-sm bg-green-100 px-1.5 py-0.5 rounded font-mono text-green-800">
              {result.absolutePath}
            </code>
            <button
              onClick={handleCopyAbsolute}
              className="shrink-0 p-0.5 text-green-600 hover:text-green-800 cursor-pointer"
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
        className="text-gray-600"
      >
        Clone again
      </Button>
    </div>
  )
}
