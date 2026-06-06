import { CircleQuestionMark, CheckCircle, AlertTriangle, XCircle, Loader2, Square } from "lucide-react"
import { Admonition } from "@/components/mdx/Admonition"
import { useState, useMemo, cloneElement, isValidElement, useRef, useEffect } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ViewSourceCode, ViewLogs, ViewOutputs, useScriptExecution, InlineMarkdown, UnmetDependenciesWarning, UnmetAuthDependencyWarning, BlockIdLabel, Instruction } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import type { AppError } from "@/types/error"

interface CheckProps {
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
  /** Reference to a GitAuth block by ID (GitHub or GitLab). The block's credentials (GITHUB_TOKEN/GITHUB_USER or GITLAB_TOKEN/GITLAB_USER) will be passed as environment variables. */
  gitAuthId?: string
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline Inputs component
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY or when simpler output handling is preferred. */
  usePty?: boolean
  /** Per-execution timeout in milliseconds. When omitted, the executor's default timeout (5 minutes) applies. */
  timeoutMs?: number
}

function Check({
  id,
  title,
  description,
  path,
  command,
  inputsId,
  awsAuthId,
  githubAuthId,
  gitAuthId,
  successMessage = "Success",
  warnMessage = "Warning",
  failMessage = "Failed",
  runningMessage = "Checking...",
  children,
  usePty,
  timeoutMs,
}: CheckProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <Check> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'Check')
  
  const { reportError, clearError } = useErrorReporting()
  
  const { trackBlockRender } = useTelemetry()

  // Instruction mode flattens this block into a copy-pasteable instruction.
  const { enabled: instructionMode } = useInstructionMode()

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
    status: checkStatus,
    logs,
    logFilePath,
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
    gitAuthId,
    children,
    componentType: 'check',
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

  // Validate required props after all hooks are called (Rules of Hooks).
  // `title` is optional (matching <Command>); add future prop validations here.
  const validationErrors = useMemo(() => {
    const errors: string[] = [];

    // Example: if (!path && !children) { errors.push('Either path or children must be provided.'); }

    return errors;
  }, []);

  // Resolve display string props using template context
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateContext) : title, [title, templateContext])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateContext) : description, [description, templateContext])
  const resolvedSuccessMessage = useMemo(() => resolveTemplateReferences(successMessage, templateContext), [successMessage, templateContext])
  const resolvedWarnMessage = useMemo(() => resolveTemplateReferences(warnMessage, templateContext), [warnMessage, templateContext])
  const resolvedFailMessage = useMemo(() => resolveTemplateReferences(failMessage, templateContext), [failMessage, templateContext])
  const resolvedRunningMessage = useMemo(() => resolveTemplateReferences(runningMessage, templateContext), [runningMessage, templateContext])

  // Check if component requires variables but none are configured
  const missingInputsConfig = inputDependencies.length > 0 && !inputsId && !awsAuthId && !inlineInputsId

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('Check')
  }, [trackBlockRender])

  // Report errors to the error reporting context
  useEffect(() => {
    // Determine if there's an error to report
    if (validationErrors.length > 0) {
      reportError({
        componentId: id,
        componentType: 'Check',
        severity: 'error',
        message: `Missing required props: ${validationErrors.join(', ')}`
      })
    } else if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'Check',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else if (getFileError) {
      reportError({
        componentId: id,
        componentType: 'Check',
        severity: 'error',
        message: getFileError.message
      })
    } else if (missingInputsConfig) {
      reportError({
        componentId: id,
        componentType: 'Check',
        severity: 'warning',
        message: `Missing Inputs configuration for variables: ${inputDependencies.join(', ')}`
      })
    } else {
      // No error, clear any previously reported error
      clearError(id)
    }
  }, [id, validationErrors, isDuplicate, getFileError, missingInputsConfig, inputDependencies, reportError, clearError])

  // Show generic error screen if there are validation errors
  if (validationErrors.length > 0) {
    return (
      <div className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
        <div className="flex items-start text-destructive">
          <XCircle className="size-6 mr-4 mt-0.5 flex-shrink-0" />
          <div className="text-md flex-1">
            <strong>Check Component Error{validationErrors.length > 1 ? 's' : ''}:</strong>
            {id && <span className="text-sm"> (Check ID: <code className="bg-destructive-muted px-1 rounded">{id}</code>)</span>}
            <ul className="list-disc ml-5 mt-2 space-y-1">
              {validationErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )
  }

  // Get visual styling based on status
  const getStatusClasses = () => {
    const statusMap = {
      success: 'bg-success-muted border-success/30',
      warn: 'bg-warning-muted border-warning/30',
      fail: 'bg-destructive-muted border-destructive/30',
      running: 'bg-info-muted border-info/40',
      pending: 'bg-muted border-border'
    }
    
    return statusMap[checkStatus]
  }

  const getStatusIcon = () => {
    const iconMap = {
      success: CheckCircle,
      warn: AlertTriangle,
      fail: XCircle,
      running: Loader2,
      pending: CircleQuestionMark
    }
    return iconMap[checkStatus]
  }

  const getStatusIconClasses = () => {
    const colorMap = {
      success: 'text-success',
      warn: 'text-warning',
      fail: 'text-destructive',
      running: 'text-info',
      pending: 'text-muted-foreground'
    }
    return colorMap[checkStatus]
  }

  const statusClasses = getStatusClasses()
  const IconComponent = getStatusIcon()
  const iconClasses = getStatusIconClasses()

  const handleStartCheck = () => {
    handleExecute()
  }

  const handleStopCheck = () => {
    cancel()
  }

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
                Another <code className="bg-destructive-muted px-1 rounded">{"<Check>"}</code> component with id <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> already exists.
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
            <strong>Check Component Error:</strong><br />
            {getFileError.message}
            {path && <span>. Failed to load file at {path}. Does the file exist? Do you have permission to read it?</span>}
          </div>
        </div>
      </div>
    )
  }
  
  // Check if script requires variables but none are configured
  if (missingInputsConfig) {
    return (
      <div className="relative rounded-sm border bg-warning-muted border-warning/30 mb-5 p-4">
        <div className="flex items-center text-warning-foreground">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong><br />
            This check script requires variables ({inputDependencies.join(', ')}) but no Inputs component is configured.
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
  // no exec:run, no logs/outputs, no pass/warn/fail state, no disabled button
  // (spec §6.4). Resolve from the raw script content regardless of dependencies.
  if (instructionMode) {
    return (
      <Instruction
        id={id}
        icon={CircleQuestionMark}
        title={resolvedTitle || (path ? 'Run this check script:' : 'Run this check:')}
        description={resolvedDescription}
        command={path ? undefined : rawScriptContent}
        source={
          path
            ? { content: rawScriptContent, path, language, fileName: 'Check Script' }
            : undefined
        }
        templateContext={templateContext}
      />
    )
  }

  // Determine if the Check button should be disabled
  const isCheckDisabled =
    checkStatus === 'running' || 
    isRendering ||
    (inputDependencies.length > 0 && !hasAllInputDependencies) ||
    !hasAllOutputDependencies ||
    !hasAwsAuthDependency ||
    !hasGitHubAuthDependency;

  // Main render - form with success indicator overlay if needed
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
      
      {/* Check main body */}
      <div className="flex @container">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <IconComponent data-testid={`icon-${checkStatus}`} className={`size-6 ${iconClasses} ${checkStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="">
        <div className="flex-1 space-y-2">
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
          {checkStatus === 'success' && resolvedSuccessMessage && (
            <div className="text-success font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedSuccessMessage}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'warn' && resolvedWarnMessage && (
            <div className="text-warning font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedWarnMessage}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'fail' && resolvedFailMessage && (
            <div className="text-destructive font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedFailMessage}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'running' && resolvedRunningMessage && (
            <div className="text-info font-semibold text-sm mb-3">
              <InlineMarkdown>{resolvedRunningMessage}</InlineMarkdown>
            </div>
          )}
          
          {/* Render inline Inputs children if present */}
          {childrenWithVariant && (
            <div className="mb-4">
              {childrenWithVariant}
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
              blockType="check"
              unmetInputDeps={unmetInputDependencies}
              unmetOutputDeps={unmetOutputDependencies}
            />
          )}
          
          {/* Show unmet AWS auth dependency */}
          {hasAllInputDependencies && hasAllOutputDependencies && (
            <UnmetAuthDependencyWarning
              dependency={unmetAwsAuthDependency}
              heading="Waiting for AWS authentication:"
              hint="Authenticate with the referenced AwsAuth block first."
            />
          )}

          {/* Show unmet GitHub auth dependency */}
          {hasAllInputDependencies && hasAllOutputDependencies && (
            <UnmetAuthDependencyWarning
              dependency={unmetGitHubAuthDependency}
              heading="Waiting for git authentication:"
              hint="Authenticate with the referenced authentication block first."
            />
          )}
          
          {renderError && hasAllOutputDependencies && (
            <div className="mb-3 text-sm text-destructive flex items-start gap-2">
              <XCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Script render error:</strong> {renderError.message}
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
                disabled={isCheckDisabled}
                onClick={handleStartCheck}
              >
                Check
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleStopCheck}
                disabled={checkStatus !== 'running'}
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
            status={checkStatus}
            autoOpen={checkStatus === 'running'}
            blockId={id}
            logFilePath={logFilePath}
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
                fileName="Check Script"
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
Check.displayName = 'Check';

export default Check;