import { FolderOpen, AlertTriangle } from "lucide-react"
import { useEffect } from "react"
import { InlineMarkdown, BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useDirPicker } from "./hooks/useDirPicker"
import type { DirPickerProps } from "./types"

function DirPicker({
  id,
  gitCloneId,
  title = "Select Directory",
  description = "Choose a target directory",
  dirLabels,
  dirLabelsExtra = false,
  pathLabel = "Target Path",
  pathLabelDescription,
}: DirPickerProps) {
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'DirPicker')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Track render
  useEffect(() => {
    trackBlockRender('DirPicker')
  }, [id, trackBlockRender])

  // Cap dropdown depth to dirLabels.length unless dirLabelsExtra is true
  const maxLevels = dirLabelsExtra ? undefined : dirLabels.length

  // Core hook
  const {
    levels,
    manualPath,
    error,
    isWorkspaceReady,
    selectDir,
    setPath,
  } = useDirPicker({ id, gitCloneId, maxLevels })

  // Report configuration errors
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'DirPicker',
        severity: 'error',
        message: `Duplicate DirPicker block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: 'DirPicker',
        severity: 'error',
        message: `DirPicker ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  // Don't render if duplicate
  if (isDuplicate || isNormalizedCollision) {
    return null
  }

  const statusClasses = error
    ? 'bg-red-50 border-red-200'
    : 'bg-white border-gray-200'

  const iconColor = error
    ? 'text-red-600'
    : 'text-gray-400'

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Main container */}
      <div className="flex @container">
        <div className="border-r border-gray-300 pr-2 mr-4 flex flex-col items-center">
          <FolderOpen className={`size-6 ${iconColor}`} />
        </div>

        <div className="flex-1 space-y-2">
          {/* Title and description */}
          <div className="text-md font-bold text-gray-700">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          <div className="text-md text-gray-600 mb-3">
            <InlineMarkdown>{description}</InlineMarkdown>
          </div>

          {/* Unmet dependency: waiting for GitClone block */}
          {!isWorkspaceReady && gitCloneId && (
            <div className="text-sm text-yellow-700 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Waiting for git clone to complete from:</strong>{' '}
                <code className="bg-yellow-100 px-1 rounded text-xs">{gitCloneId}</code>
                <div className="text-xs mt-1 text-yellow-600">
                  Complete the GitClone block above to browse directories.
                </div>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="text-sm text-red-600">{error}</div>
          )}

          {/* Cascading directory dropdowns (vertical, full width) */}
          {isWorkspaceReady && levels.length > 0 && (
            <div className="space-y-2">
              {levels.map((level, index) => {
                const levelLabel = dirLabels[index] ?? `Level ${index + 1}`
                return (
                  <div key={level.path} className="flex items-center gap-3">
                    <label className="text-sm font-medium text-gray-700 w-24 shrink-0 text-right">
                      {levelLabel}
                    </label>
                    <select
                      value={level.selected}
                      onChange={(e) => selectDir(index, e.target.value)}
                      disabled={level.loading}
                      className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
                    >
                      <option value="">
                        {`Select ${levelLabel.toLowerCase()}...`}
                      </option>
                      {level.dirs.map(dir => (
                        <option key={dir} value={dir}>{dir}</option>
                      ))}
                    </select>
                  </div>
                )
              })}

              {/* Editable path input — visually separated from dropdowns */}
              <div className="border-t border-gray-200 pt-3 mt-3">
                <label className="text-sm font-semibold text-gray-800 mb-0.5 block">
                  {pathLabel}
                </label>
                {pathLabelDescription && (
                  <p className="text-xs text-gray-500 mb-1.5 m-0">
                    <InlineMarkdown>{pathLabelDescription}</InlineMarkdown>
                  </p>
                )}
                <input
                  type="text"
                  value={manualPath}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="e.g., production/us-east-1/services"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white placeholder:text-gray-400 font-mono"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Set displayName for React DevTools and component detection
DirPicker.displayName = 'DirPicker';

export default DirPicker;
