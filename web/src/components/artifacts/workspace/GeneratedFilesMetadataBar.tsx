/**
 * @fileoverview GeneratedFilesMetadataBar Component
 *
 * Displays generated-files metadata: file count and local output path.
 * Layout mirrors RepositoryMetadataBar for visual consistency.
 */

import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDisplayPath } from "@/contexts/useDisplayPath"
import { LocalPathRow } from "./rows/LocalPathRow"

interface GeneratedFilesMetadataBarProps {
  /** Absolute path to the generated files output directory */
  absolutePath?: string | undefined
  /** Relative path to the generated files output directory */
  relativePath?: string | undefined
  /** Number of generated files */
  fileCount: number
  /** Number of generated files changed since the user reviewed them */
  changedCount?: number | undefined
  /** Mark every generated file reviewed */
  onDismissAll?: (() => void) | undefined
  /** Additional CSS classes */
  className?: string | undefined
}

export const GeneratedFilesMetadataBar = ({
  absolutePath,
  relativePath,
  fileCount,
  changedCount = 0,
  onDismissAll,
  className = "",
}: GeneratedFilesMetadataBarProps) => {
  const displayPath = useDisplayPath()
  const displayText = absolutePath
    ? displayPath(absolutePath)
    : relativePath
      ? `./${relativePath}`
      : null

  return (
    <div className={cn("py-2.5 border-b border-border", className)}>
      {/* Row 1: Title */}
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-foreground font-medium">
          {fileCount} {fileCount === 1 ? "file" : "files"} generated
        </span>
        {changedCount > 0 && (
          <>
            <span className="text-muted-foreground">·</span>
            <span
              className="text-warning-foreground font-medium"
              title="Changed since you last reviewed them"
            >
              {changedCount} changed
            </span>
            {onDismissAll && (
              <button
                onClick={onDismissAll}
                className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                title="Mark every file as reviewed: stop highlighting their changes"
              >
                <Check className="w-3 h-3" />
                Dismiss all
              </button>
            )}
          </>
        )}
      </div>

      {/* Row 2: Output path (shortened display, copies absolute) */}
      {displayText && (
        <LocalPathRow displayText={displayText} copyPath={absolutePath} className="mt-1.5" />
      )}
    </div>
  )
}
