/**
 * @fileoverview GeneratedFilesMetadataBar Component
 *
 * Displays generated-files metadata: file count and local output path.
 * Layout mirrors RepositoryMetadataBar for visual consistency.
 */

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
  /** Additional CSS classes */
  className?: string | undefined
}

export const GeneratedFilesMetadataBar = ({
  absolutePath,
  relativePath,
  fileCount,
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
      </div>

      {/* Row 2: Output path (shortened display, copies absolute) */}
      {displayText && (
        <LocalPathRow displayText={displayText} copyPath={absolutePath} className="mt-1.5" />
      )}
    </div>
  )
}
