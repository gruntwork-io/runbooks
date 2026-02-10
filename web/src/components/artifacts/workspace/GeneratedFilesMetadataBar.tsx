/**
 * @fileoverview GeneratedFilesMetadataBar Component
 *
 * Displays generated-files metadata: file count and local output path.
 * Layout mirrors RepositoryMetadataBar for visual consistency.
 */

import { cn } from '@/lib/utils'
import { LocalPathRow } from './rows/LocalPathRow'

interface GeneratedFilesMetadataBarProps {
  /** Absolute path to the generated files output directory */
  absolutePath?: string;
  /** Relative path to the generated files output directory */
  relativePath?: string;
  /** Number of generated files */
  fileCount: number;
  /** Additional CSS classes */
  className?: string;
}

export const GeneratedFilesMetadataBar = ({
  absolutePath,
  relativePath,
  fileCount,
  className = "",
}: GeneratedFilesMetadataBarProps) => {
  const displayText = relativePath
    ? `./${relativePath}`
    : absolutePath
      ? `./${absolutePath.split('/').pop()}`
      : null

  return (
    <div className={cn("py-2.5 border-b border-gray-300", className)}>
      {/* Row 1: Title */}
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-gray-800 font-medium">
          {fileCount} {fileCount === 1 ? 'file' : 'files'} generated
        </span>
      </div>

      {/* Row 2: Output path (relative display, copies absolute) */}
      {displayText && (
        <LocalPathRow
          displayText={displayText}
          copyPath={absolutePath}
          className="mt-1.5"
        />
      )}
    </div>
  )
}
