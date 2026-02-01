import { CircleQuestionMark, CheckCircle, AlertTriangle, XCircle, Loader2, Square } from "lucide-react"
import { Admonition } from "@/components/mdx/Admonition"
import { useState, useMemo, cloneElement, isValidElement, useRef, useEffect } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ViewSourceCode, ViewLogs, ViewOutputs, useScriptExecution, InlineMarkdown, UnmetOutputDependenciesWarning, UnmetInputDependenciesWarning, UnmetAwsAuthDependencyWarning, BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"

interface CheckProps {
  id: string
  title: string
  description?: string
  path?: string
  command?: string
  /** Reference to one or more Inputs by ID for template variable substitution. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Reference to an AwsAuth block by ID for AWS credentials. The credentials will be passed as environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION). */
  awsAuthId?: string
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline Inputs component
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY or when simpler output handling is preferred. */
  usePty?: boolean
}

function Check({
  id,
  title,
  description,
  path,
  command,
  inputsId,
  awsAuthId,
  successMessage = "Success",
  warnMessage = "Warning",
  failMessage = "Failed",
  runningMessage = "Checking...",
  children,
  usePty,
}: CheckProps) {
  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'Check')
  
  // Error reporting context
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Use shared script execution hook
  const {
    sourceCode,
    language,
    fileError: getFileError,
    inputValues,
    inputDependencies,
    hasAllInputDependencies,
    inlineInputsId,
    unmetOutputDependencies,
    hasAllOutputDependencies,
    unmetAwsAuthDependency,
    hasAwsAuthDependency,
    isRendering,
    renderError,
    status: checkStatus,
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
    children,
    componentType: 'check',
    usePty,
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

  // Validate required props after all hooks are called (Rules of Hooks)
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    
    if (!title) {
      errors.push('The <code>title</code> prop is required but was not provided.');
    }
    
    // Add more validation checks here as needed
    // Example: if (!path && !children) { errors.push('Either path or children must be provided.'); }
    
    return errors;
  }, [title]);

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
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-start text-red-600">
          <XCircle className="size-6 mr-4 mt-0.5 flex-shrink-0" />
          <div className="text-md flex-1">
            <strong>Check Component Error{validationErrors.length > 1 ? 's' : ''}:</strong>
            {id && <span className="text-sm"> (Check ID: <code className="bg-red-100 px-1 rounded">{id}</code>)</span>}
            <ul className="list-disc ml-5 mt-2 space-y-1">
              {validationErrors.map((error, index) => (
                <li key={index} dangerouslySetInnerHTML={{ __html: error }} />
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
      success: 'bg-green-50 border-green-200',
      warn: 'bg-yellow-50 border-yellow-300', 
      fail: 'bg-red-50 border-red-200',
      running: 'bg-blue-50 border-blue-200',
      pending: 'bg-gray-100 border-gray-200'
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
      success: 'text-green-600',
      warn: 'text-yellow-600',
      fail: 'text-red-600',
      running: 'text-blue-600',
      pending: 'text-gray-500'
    }
    return colorMap[checkStatus]
  }

  const statusClasses = getStatusClasses()
  const IconComponent = getStatusIcon()
  const iconClasses = getStatusIconClasses()

  // Handle starting the check
  const handleStartCheck = () => {
    handleExecute()
  }

  // Handle stopping the check
  const handleStopCheck = () => {
    cancel()
  }

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong><br />
                The ID <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> collides with <code className="bg-red-100 px-1 rounded">{`"${collidingId}"`}</code> because 
                hyphens are converted to underscores for template access.
                Use different IDs to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate Component ID:</strong><br />
                Another <code className="bg-red-100 px-1 rounded">{"<Check>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
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
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
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
      <div className="relative rounded-sm border bg-yellow-50 border-yellow-200 mb-5 p-4">
        <div className="flex items-center text-yellow-700">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong><br />
            This check script requires variables ({inputDependencies.join(', ')}) but no Inputs component is configured. 
            Please add either:
            <ul className="list-disc ml-6 mt-2">
              <li>An inline <code className="bg-yellow-100 px-1 rounded">{"<Inputs>"}</code> component as a child</li>
              <li>An <code className="bg-yellow-100 px-1 rounded">inputsId</code> prop referencing an existing Inputs</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }
  
  // Determine if the Check button should be disabled
  const isCheckDisabled = 
    checkStatus === 'running' || 
    isRendering ||
    (inputDependencies.length > 0 && !hasAllInputDependencies) ||
    !hasAllOutputDependencies ||
    !hasAwsAuthDependency;

  // Main render - form with success indicator overlay if needed
  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>      
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Script drift warning - mr-12 leaves room for the ID label */}
      {hasScriptDrift && (
        <Admonition type="warning" title="Script changed" className="space-y-2 mr-12">
          <p>This script has changed since the runbook was opened. Although the <em>UI</em> shows the latest version, for security reasons, Runbooks will <em>execute</em> the version that was present when the runbook was first opened.</p>
          <p>To execute the latest version, reload the runbook (e.g. <code className="bg-yellow-100 px-1 rounded text-xs">runbooks open</code>). If you are authoring this runbook, consider using <code className="bg-yellow-100 px-1 rounded text-xs">runbooks watch</code> to automatically load script changes.</p>
        </Admonition>
      )}
      
      {/* Check main body */}
      <div className="flex @container">
        <div className="border-r border-gray-300 pr-2 mr-4 flex flex-col items-center">
          <IconComponent className={`size-6 ${iconClasses} ${checkStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="">
        <div className="flex-1 space-y-2">
          <div className="text-md font-bold text-gray-600">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          {description && (
            <div className="text-md text-gray-600 mb-3">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'success' && successMessage && (
            <div className="text-green-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{successMessage}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'warn' && warnMessage && (
            <div className="text-yellow-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{warnMessage}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'fail' && failMessage && (
            <div className="text-red-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{failMessage}</InlineMarkdown>
            </div>
          )}
          {checkStatus === 'running' && runningMessage && (
            <div className="text-blue-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{runningMessage}</InlineMarkdown>
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
          <div className="border-b border-gray-300"></div>
          
          {/* Show status messages for waiting/rendering/error states */}      
          {!isRendering && (
            <UnmetInputDependenciesWarning
              blockType="check"
              inputDependencies={inputDependencies}
              inputValues={inputValues}
            />
          )}
          
          {/* Show unmet output dependencies */}
          {hasAllInputDependencies && (
            <UnmetOutputDependenciesWarning unmetOutputDependencies={unmetOutputDependencies} />
          )}
          
          {/* Show unmet AWS auth dependency */}
          {hasAllInputDependencies && hasAllOutputDependencies && (
            <UnmetAwsAuthDependencyWarning unmetAwsAuthDependency={unmetAwsAuthDependency} />
          )}
          
          {renderError && hasAllOutputDependencies && (
            <div className="mb-3 text-sm text-red-600 flex items-start gap-2">
              <XCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Script render error:</strong> {renderError.message}
                {renderError.details && <div className="text-xs mt-1 text-red-500">{renderError.details}</div>}
              </div>
            </div>
          )}
          
          {execError && (
            <div className="mb-3 text-sm text-red-600 flex items-start gap-2">
              <XCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>{execError.message}</strong>
                {execError.details && <div className="text-xs mt-1 text-red-500">{execError.details}</div>}
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
                className="text-red-600 hover:text-red-700 hover:bg-red-50 disabled:text-gray-400 disabled:hover:bg-transparent"
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