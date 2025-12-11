import { CircleQuestionMark, CheckCircle, AlertTriangle, XCircle, Loader2, Square, CircleSlash } from "lucide-react"
import { useState, useMemo, cloneElement, isValidElement, useRef } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ViewSourceCode, ViewLogs, useScriptExecution, InlineMarkdown } from "@/components/mdx/_shared"
import { formatVariableLabel } from "@/components/mdx/_shared/lib/formatVariableLabel"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"

interface CheckProps {
  id: string
  title: string
  description?: string
  path?: string
  command?: string
  /** Reference to one or more Inputs by ID. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline Inputs component
}

function Check({
  id,
  title,
  description,
  path,
  command,
  inputsId,
  successMessage = "Success",
  warnMessage = "Warning",
  failMessage = "Failed",
  runningMessage = "Checking...",
  children,
}: CheckProps) {
  // Check for duplicate component IDs
  const { isDuplicate } = useComponentIdRegistry(id, 'Check')

  // Use shared script execution hook
  const {
    sourceCode,
    language,
    fileError: getFileError,
    collectedVariables,
    requiredVariables,
    hasAllRequiredVariables,
    inlineInputsId,
    isRendering,
    renderError,
    status: checkStatus,
    logs,
    execError,
    execute: handleExecute,
    cancel,
  } = useScriptExecution({
    componentId: id,
    path,
    command,
    inputsId,
    children,
    componentType: 'check'
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
  
  const [skipCheck, setSkipCheck] = useState(false);

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
    if (skipCheck) return 'bg-gray-100 border-gray-200'
    
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
    if (skipCheck) return 'text-gray-300'
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
            <strong>Duplicate Component ID:</strong><br />
            Another <code className="bg-red-100 px-1 rounded">{"<Check>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
            Each component must have a unique ID.
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
  if (requiredVariables.length > 0 && !inputsId && !inlineInputsId) {
    return (
      <div className="relative rounded-sm border bg-yellow-50 border-yellow-200 mb-5 p-4">
        <div className="flex items-center text-yellow-700">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong><br />
            This check script requires variables ({requiredVariables.join(', ')}) but no Inputs component is configured. 
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
    skipCheck || 
    checkStatus === 'running' || 
    isRendering ||
    (requiredVariables.length > 0 && !hasAllRequiredVariables);

  // Main render - form with success indicator overlay if needed
  return (
    <div className={`relative rounded-sm border ${statusClasses} mb-5 p-4`}>      
      {/* Skip overlay */}
      {skipCheck && (
        <div className="absolute inset-0 bg-gray-500/20 border-2 border-gray-200 rounded-sm z-10"></div>
      )}
      
      {/* Check main body */}
      <div className="flex @container">
        <div className="border-r border-gray-300 pr-2 mr-4">
          <IconComponent className={`size-6 ${iconClasses} mr-1 ${checkStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="">
        
        {skipCheck && (
          <div className="mb-3 text-sm text-gray-800 bg-gray-300 w-fit p-3 flex items-center gap-2">
            <CircleSlash className="size-4" />
            This check has been skipped.
          </div>
        )}

        <div className={`flex-1 space-y-2 ${skipCheck ? 'opacity-40' : ''}`}>
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
          {requiredVariables.length > 0 && !hasAllRequiredVariables && !isRendering && (
            <div className="mb-3 text-sm text-yellow-700 flex items-center gap-2">
              <AlertTriangle className="size-4" />
              You can run the check once we have values for the following variables: {requiredVariables.filter(varName => {
                const value = collectedVariables[varName];
                return value === undefined || value === null || value === '';
              }).map(varName => formatVariableLabel(varName)).join(', ')}
            </div>
          )}
          
          {renderError && (
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
        
        {/* Checkbox positioned in top right */}
        <div className={`@md:absolute @md:top-4 @md:right-4 flex items-center gap-2 self-start z-20` + (checkStatus === 'success' ? ' text-gray-300' : '')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox 
              className="bg-white" 
              checked={skipCheck} 
              disabled={checkStatus === 'success'}
              onCheckedChange={(checked) => setSkipCheck(checked === true)} 
            />
            <span className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 select-none">
              Skip
            </span>
          </label>
        </div>
      </div>

      {/* Expandable sections inside the main box */}
      <div className="mt-4 space-y-2">
        <ViewLogs 
            logs={logs}
            status={checkStatus}
            autoOpen={checkStatus === 'running'}
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