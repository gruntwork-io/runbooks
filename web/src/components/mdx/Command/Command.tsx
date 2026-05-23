import { SquareTerminal, CheckCircle, XCircle, Loader2, Square, AlertTriangle } from "lucide-react"
import { Admonition } from "@/components/mdx/Admonition"
import { useState, useMemo, cloneElement, isValidElement, useRef, useEffect } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ViewSourceCode, ViewLogs, ViewOutputs, useScriptExecution, InlineMarkdown, UnmetDependenciesWarning, UnmetAwsAuthDependencyWarning, UnmetGitHubAuthDependencyWarning, BlockIdLabel, Instruction } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import type { AppError } from "@/types/error"

interface CommandProps {
  id: string
  title?: string
  description?: string
  path?: string
  command?: string
  /** Reference to one or more Inputs by ID for template variable substitution. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Reference to an AwsAuth block by ID for AWS credentials. The credentials will be passed as environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION). */
  awsAuthId?: string
  /** Reference to a GitHubAuth block by ID for GitHub credentials. The credentials will be passed as environment variables (GITHUB_TOKEN, GITHUB_USER). */
  githubAuthId?: string
  successMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline Inputs component
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY or when simpler output handling is preferred. */
  usePty?: boolean
  /** Per-execution timeout in milliseconds. When omitted, the executor's default timeout (5 minutes) applies. */
  timeoutMs?: number
}

function Command({
  id,
  title,
  description,
  path,
  command,
  inputsId,
  awsAuthId,
  githubAuthId,
  successMessage = "Success",
  failMessage = "Failed",
  runningMessage = "Running...",
  children,
  usePty,
  timeoutMs,
}: CommandProps) {
  // Validate required props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <Command> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'Command')
  
  // Error reporting context
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Instruction mode flattens this block into a copy-pasteable instruction.
  const { enabled: instructionMode } = useInstructionMode()

  // Use shared script execution hook
  const {
    sourceCode,
    rawScriptContent,
    language,
    fileError: getFileError,
    inputDependencies,
    unmetInputDependencies,
    hasAllInputDependencies,
    inlineInputsId,
    unmetOutputDependencies,
    hasAllOutputDependencies,
    unmetAwsAuthDependency,
    hasAwsAuthDependency,
    unmetGitHubAuthDependency,
    hasGitHubAuthDependency,
    isRendering,
    renderError,
    templateContext,
    status: commandStatus,
    logs,
    execError,
    execute: handleExecute,
    cancel,
    outputs,
    hasScriptDrift,
  } = useScriptExecution({
    componentId: id,
    path,
    command,
    inputsId,
    awsAuthId,
    githubAuthId,
    children,
    componentType: 'command',
    usePty,
    timeoutMs,
  })
  
  // Clone children and add variant="embedded" prop if it's an Inputs component
  const childrenWithVariant = useMemo(() => {
    if (!children) return null;
    
    // If children is a valid React element, clone it with variant prop
    if (isValidElement(children)) {
      return cloneElement(children, { variant: 'embedded' } as Record<string, unknown>);
    }
    
    return children;
  }, [children]);

  // State for controlling ViewSourceCode
  const [showSourceCode, setShowSourceCode] = useState(false);
  
  // Ref for scrolling to ViewSourceCode section
  const viewSourceCodeRef = useRef<HTMLDivElement>(null);

  // Get visual styling based on status
  const getStatusClasses = () => {
    const statusMap = {
      success: 'bg-success-muted border-success/30',
      fail: 'bg-destructive-muted border-destructive/30',
      running: 'bg-info-muted border-info/40',
      pending: 'bg-muted border-border',
      warn: 'bg-warning-muted border-warning/30' // Should not happen for Command, but include for type safety
    }
    
    return statusMap[commandStatus]
  }

  const getStatusIcon = () => {
    const iconMap = {
      success: CheckCircle,
      fail: XCircle,
      running: Loader2,
      pending: SquareTerminal, // Terminal icon for pending state
      warn: AlertTriangle // Should not happen for Command
    }
    return iconMap[commandStatus]
  }

  const getStatusIconClasses = () => {
    const colorMap = {
      success: 'text-success',
      fail: 'text-destructive',
      running: 'text-info',
      pending: 'text-muted-foreground',
      warn: 'text-warning' // Should not happen for Command
    }
    return colorMap[commandStatus]
  }

  const statusClasses = getStatusClasses()
  const IconComponent = getStatusIcon()
  const iconClasses = getStatusIconClasses()

  // Handle starting the command
  const handleStartCommand = () => {
    handleExecute()
  }

  // Handle stopping the command
  const handleStopCommand = () => {
    cancel()
  }

  // Determine if we should display the command inline
  const displayCommand = useMemo(() => {
    // Don't display if using path (ViewSourceCode handles it)
    if (path) return null
    
    // Display inline command if present
    if (command) {
      const isMultiLine = command.includes('\n')
      return { content: sourceCode, isMultiLine } // Use sourceCode (may be rendered with variables)
    }
    
    return null
  }, [path, command, sourceCode])

  // Calculate script metadata for file-based scripts
  const scriptMetadata = useMemo(() => {
    if (!path || command) return null
    
    const lines = sourceCode.split('\n').length
    const languageDisplay = language || 'shell'
    
    return { lines, language: languageDisplay }
  }, [path, command, sourceCode, language])

  // Resolve display string props using template context
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateContext) : title, [title, templateContext])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateContext) : description, [description, templateContext])
  const resolvedSuccessMessage = useMemo(() => resolveTemplateReferences(successMessage, templateContext), [successMessage, templateContext])
  const resolvedFailMessage = useMemo(() => resolveTemplateReferences(failMessage, templateContext), [failMessage, templateContext])
  const resolvedRunningMessage = useMemo(() => resolveTemplateReferences(runningMessage, templateContext), [runningMessage, templateContext])

  // Check if component requires variables but none are configured
  const missingInputsConfig = inputDependencies.length > 0 && !inputsId && !awsAuthId && !inlineInputsId

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('Command')
  }, [trackBlockRender])

  // Report errors to the error reporting context
  useEffect(() => {
    // Determine if there's an error to report
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'Command',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else if (getFileError) {
      reportError({
        componentId: id,
        componentType: 'Command',
        severity: 'error',
        message: getFileError.message
      })
    } else if (missingInputsConfig) {
      reportError({
        componentId: id,
        componentType: 'Command',
        severity: 'warning',
        message: `Missing Inputs configuration for variables: ${inputDependencies.join(', ')}`
      })
    } else {
      // No error, clear any previously reported error
      clearError(id)
    }
  }, [id, isDuplicate, getFileError, missingInputsConfig, inputDependencies, reportError, clearError])

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong><br />
                The ID <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> collides with <code className="bg-destructive-muted px-1 rounded">{`"${collidingId}"`}</code> because
                hyphens are converted to underscores for template access.
                Use different IDs to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate Component ID:</strong><br />
                Another <code className="bg-destructive-muted px-1 rounded">{"<Command>"}</code> component with id <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> already exists.
                Each component must have a unique ID.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Early return for file errors - show only error message
  if (getFileError) {
    return (
      <div className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Command Component Error:</strong><br />
            {getFileError.message}
            {path && <span>. Failed to load file at {path}. Does the file exist? Do you have permission to read it?</span>}
          </div>
        </div>
      </div>
    )
  }
  
  // Check if command/script requires variables but none are configured
  if (missingInputsConfig) {
    return (
      <div className="relative rounded-sm border bg-warning-muted border-warning/30 mb-5 p-4">
        <div className="flex items-center text-warning-foreground">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong><br />
            This command requires variables ({inputDependencies.join(', ')}) but no Inputs component is configured.
            Please add either:
            <ul className="list-disc ml-6 mt-2">
              <li>An inline <code className="bg-warning-muted px-1 rounded">{"<Inputs>"}</code> component as a child</li>
              <li>An <code className="bg-warning-muted px-1 rounded">inputsId</code> prop referencing an existing Inputs</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }
  
  // Instruction mode: flatten to a copy-pasteable instruction. Nothing runs —
  // no exec:run, no logs/outputs, no disabled Run button (spec §6.4). Resolve
  // from the raw script content so it works regardless of dependency state.
  if (instructionMode) {
    return (
      <Instruction
        id={id}
        title={resolvedTitle || (path ? 'Run this script:' : 'Run this command:')}
        description={resolvedDescription}
        command={path ? undefined : rawScriptContent}
        source={
          path
            ? { content: rawScriptContent, path, language, fileName: 'Command Script' }
            : undefined
        }
        templateContext={templateContext}
      />
    )
  }

  // Determine if the Run button should be disabled
  const isRunDisabled =
    commandStatus === 'running' || 
    isRendering ||
    (inputDependencies.length > 0 && !hasAllInputDependencies) ||
    !hasAllOutputDependencies ||
    !hasAwsAuthDependency ||
    !hasGitHubAuthDependency;

  // Main render
  return (
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>      
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Script drift warning - mr-12 leaves room for the ID label */}
      {hasScriptDrift && (
        <Admonition type="warning" title="Script changed" className="space-y-2 mr-12">
          <p>This script has changed since the runbook was opened. Although the <em>UI</em> shows the latest version, for security reasons, Runbooks will <em>execute</em> the version that was present when the runbook was first opened.</p>
          <p>To execute the latest version, reload the runbook (e.g. <code className="bg-warning-muted px-1 rounded text-xs">runbooks open</code>). If you are authoring this runbook, consider using <code className="bg-warning-muted px-1 rounded text-xs">runbooks watch</code> to automatically load script changes. If reloading doesn't resolve this, check for escape sequences (e.g. <code className="bg-warning-muted px-1 rounded text-xs">\n</code>) in inline commands that may be interpreted differently by the browser and backend.</p>
        </Admonition>
      )}

      {/* Command main container */}
      <div className="flex @container">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <IconComponent data-testid={`icon-${commandStatus}`} className={`size-6 ${iconClasses} ${commandStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="">
        {/* Command main body */}
        <div className="flex-1 space-y-2">
          {commandStatus === 'pending' && command && !title && (
            <div className="text-muted-foreground font-semibold text-sm">Run a command</div>
          )}
          {commandStatus === 'pending' && !command && path && !title && (
            <div className="text-muted-foreground font-semibold text-sm">Run a script</div>
          )}

          {/* Title and description */}
          {resolvedTitle && (
            <div className="text-md font-bold text-muted-foreground">
              <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
            </div>
          )}
          {resolvedDescription && (
            <div className="text-md text-muted-foreground mb-3">
              <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
            </div>
          )}

          {commandStatus === 'success' && resolvedSuccessMessage && (
            <div className="text-success font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedSuccessMessage}</InlineMarkdown>
            </div>
          )}
          {commandStatus === 'fail' && resolvedFailMessage && (
            <div className="text-destructive font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedFailMessage}</InlineMarkdown>
            </div>
          )}
          {commandStatus === 'running' && resolvedRunningMessage && (
            <div className="text-info font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedRunningMessage}</InlineMarkdown>
            </div>
          )}
          
          {/* Render inline BoilerplateInputs children if present */}
          {childrenWithVariant && (
            <div className="mb-4">
              {childrenWithVariant}
            </div>
          )}
          
          {/* Display script metadata for file-based scripts */}
          {scriptMetadata && (
            <div className="text-xs text-muted-foreground flex items-center flex-wrap gap-3 mb-2">
              <span className="inline-flex items-center gap-1">
                <span className="font-semibold">Language:</span>
                <span className="font-mono bg-muted rounded">{scriptMetadata.language}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="font-semibold">Lines:</span>
                <span className="font-mono">{scriptMetadata.lines}</span>
              </span>
              {path && (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <span className="font-semibold">Path:</span>
                  <span className="font-mono truncate max-w-xs" title={path}>{path}</span>
                </span>
              )}
              <button
                onClick={() => {
                  setShowSourceCode(true)
                  // Scroll to ViewSourceCode section with a slight delay to ensure it's open
                  setTimeout(() => {
                    viewSourceCodeRef.current?.scrollIntoView({ 
                      behavior: 'smooth', 
                      block: 'nearest' 
                    })
                  }, 100)
                }}
                className="inline-flex items-center gap-1 text-primary hover:text-primary/80 hover:underline cursor-pointer"
              >
                View Source Code
              </button>
            </div>
          )}
          
          {/* Display inline command if present */}
          {displayCommand && (
            <div className={`font-mono text-xs mb-3 bg-gray-900 rounded p-3 text-gray-100 whitespace-pre-wrap`}>
              {displayCommand.content}
            </div>
          )}

          {/* Separator */}
          <div className="border-b border-border"></div>

          {/* Show unmet input/output dependencies */}
          {!isRendering && (
            <UnmetDependenciesWarning
              blockType="command"
              unmetInputDeps={unmetInputDependencies}
              unmetOutputDeps={unmetOutputDependencies}
            />
          )}
          
          {/* Show unmet AWS auth dependency */}
          {hasAllInputDependencies && hasAllOutputDependencies && (
            <UnmetAwsAuthDependencyWarning unmetAwsAuthDependency={unmetAwsAuthDependency} />
          )}
          
          {/* Show unmet GitHub auth dependency */}
          {hasAllInputDependencies && hasAllOutputDependencies && (
            <UnmetGitHubAuthDependencyWarning unmetGitHubAuthDependency={unmetGitHubAuthDependency} />
          )}
          
          {renderError && hasAllOutputDependencies && (
            <div className="mb-3 text-sm text-destructive flex items-start gap-2">
              <XCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Command render error:</strong> {renderError.message}
                {renderError.details && <div className="text-xs mt-1 text-destructive">{renderError.details}</div>}
              </div>
            </div>
          )}

          {execError && (
            <div className="mb-3 text-sm text-destructive flex items-start gap-2">
              <XCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>{execError.message}</strong>
                {execError.details && <div className="text-xs mt-1 text-destructive">{execError.details}</div>}
              </div>
            </div>
          )}
          
          <div className="flex items-center w-full justify-between">
            <div className="flex items-center gap-2">
              <Button 
                variant="outline"
                size="sm"
                disabled={isRunDisabled}
                onClick={handleStartCommand}
              >
                Run
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleStopCommand}
                disabled={commandStatus !== 'running'}
                className="text-destructive hover:text-destructive hover:bg-destructive-muted disabled:text-muted-foreground disabled:hover:bg-transparent"
              >
                <Square className="size-4 mr-1" />
                Stop
              </Button>
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* Expandable sections inside the main box */}
      <div className="mt-4 space-y-2">
        <ViewLogs 
            logs={logs}
            status={commandStatus}
            autoOpen={commandStatus === 'running'}
            blockId={id}
          />
          <ViewOutputs 
            outputs={outputs}
            autoOpen={outputs !== null && Object.keys(outputs).length > 0}
          />
          {/* Only show ViewSourceCode if path is used */}
          {path && (
            <div ref={viewSourceCodeRef}>
              <ViewSourceCode 
                sourceCode={sourceCode}
                path={path}
                language={language}
                fileName="Command Script"
                isOpen={showSourceCode}
                onToggle={setShowSourceCode}
              />
            </div>
          )}
      </div>
    </div>
  )
}

// Set displayName for React DevTools and component detection
Command.displayName = 'Command';

export default Command;

