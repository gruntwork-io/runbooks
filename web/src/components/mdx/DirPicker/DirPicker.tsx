import { FolderOpen, AlertTriangle } from "lucide-react"
import { useEffect, useMemo } from "react"
import { InlineMarkdown, BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useTemplateContext } from "@/contexts/useRunbook"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { useDirPicker } from "./hooks/useDirPicker"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import type { AppError } from "@/types/error"
import type { DirPickerProps } from "./types"

function DirPicker({
  id,
  rootDir,
  gitCloneId,
  title = "Select Directory",
  description = "Choose a target directory",
  dirLabels,
  dirLabelsExtra = false,
  pathLabel = "Target Path",
  pathLabelDescription,
  inputsId,
}: DirPickerProps) {
  // Validate required props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <DirPicker> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Resolve template expressions in display props (non-blocking - all props are display-only)
  const templateCtx = useTemplateContext(inputsId)

  // Resolve display props - no dependency tracking since all props are non-blocking (display-only)
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateCtx) : title, [title, templateCtx])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateCtx) : description, [description, templateCtx])
  const resolvedPathLabel = useMemo(() => pathLabel ? resolveTemplateReferences(pathLabel, templateCtx) : pathLabel, [pathLabel, templateCtx])
  const resolvedPathLabelDescription = useMemo(() => pathLabelDescription ? resolveTemplateReferences(pathLabelDescription, templateCtx) : pathLabelDescription, [pathLabelDescription, templateCtx])

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
  } = useDirPicker({ id, rootDir, gitCloneId, maxLevels })

  const missingRootConfig = !rootDir && !gitCloneId

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
    } else if (missingRootConfig) {
      reportError({
        componentId: id,
        componentType: 'DirPicker',
        severity: 'error',
        message: `DirPicker "${id}" requires either a rootDir or gitCloneId prop`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, missingRootConfig, reportError, clearError])

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Don't render if duplicate
  if (isDuplicate || isNormalizedCollision) {
    return null
  }

  const hasError = error || missingRootConfig

  const statusClasses = hasError
    ? 'bg-destructive-muted border-destructive/30'
    : 'bg-card border-border'

  const iconColor = hasError
    ? 'text-destructive'
    : 'text-muted-foreground'

  return (
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Main container */}
      <div className="flex @container">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <FolderOpen className={`size-6 ${iconColor}`} />
        </div>

        <div className="flex-1 space-y-2">
          {/* Title and description */}
          <div className="text-md font-bold text-foreground">
            <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
          </div>
          <div className="text-md text-muted-foreground mb-3">
            <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
          </div>

          {/* Missing configuration: neither rootDir nor gitCloneId */}
          {missingRootConfig && (
            <div className="text-sm text-destructive flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <span>
                DirPicker requires either a <code className="bg-destructive-muted px-1 rounded text-xs">rootDir</code> or <code className="bg-destructive-muted px-1 rounded text-xs">gitCloneId</code> prop.
              </span>
            </div>
          )}

          {/* Unmet dependency: waiting for GitClone block */}
          {!isWorkspaceReady && gitCloneId && (
            <div className="text-sm text-warning flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Waiting for git clone to complete from:</strong>{' '}
                <code className="bg-warning-muted px-1 rounded text-xs">{gitCloneId}</code>
                <div className="text-xs mt-1 text-warning">
                  Complete the GitClone block above to browse directories.
                </div>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}

          {/* Cascading directory dropdowns (vertical, full width) */}
          {isWorkspaceReady && levels.length > 0 && (
            <div className="space-y-2">
              {levels.map((level, index) => {
                const levelLabel = dirLabels[index] ?? `Level ${index + 1}`
                return (
                  <div key={level.path} className="flex items-center gap-3">
                    <label className="text-sm font-medium text-foreground w-24 shrink-0 text-right">
                      {levelLabel}
                    </label>
                    <select
                      value={level.selected}
                      onChange={(e) => selectDir(index, e.target.value)}
                      disabled={level.loading}
                      className="flex-1 px-2 py-1.5 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground"
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
              <div className="border-t border-border pt-3 mt-3">
                <label className="text-sm font-semibold text-foreground mb-0.5 block">
                  {resolvedPathLabel}
                </label>
                {resolvedPathLabelDescription && (
                  <p className="text-xs text-muted-foreground mb-1.5 m-0">
                    <InlineMarkdown>{resolvedPathLabelDescription}</InlineMarkdown>
                  </p>
                )}
                <input
                  type="text"
                  value={manualPath}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="e.g., production/us-east-1/services"
                  className="w-full px-3 py-2 text-sm border border-input rounded-md bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring focus:bg-card placeholder:text-muted-foreground font-mono"
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
