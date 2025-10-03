import { SquareTerminal, CheckCircle, XCircle, Loader2, Square, AlertTriangle, CircleSlash } from "lucide-react"
import { useState, useMemo, cloneElement, isValidElement, useRef } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ViewSourceCode, ViewLogs, useScriptExecution, InlineMarkdown } from "@/components/mdx/shared"
import { formatVariableLabel } from "@/components/mdx/BoilerplateInputs/lib/formatVariableLabel"

interface CommandProps {
  id: string
  title?: string
  description?: string
  path?: string
  command?: string
  boilerplateInputsId?: string
  successMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline BoilerplateInputs component
}

function Command({
  id,
  title,
  description,
  path,
  command,
  boilerplateInputsId,
  successMessage = "Success",
  failMessage = "Failed",
  runningMessage = "Running...",
  children,
}: CommandProps) {
  // Suppress unused parameter warnings for future use
  void id;
  
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
    status: commandStatus,
    logs,
    execError,
    execute: handleExecute,
    cancel,
  } = useScriptExecution({
    path,
    command,
    boilerplateInputsId,
    children,
    componentType: 'command'
  })
  
  // Clone children and add variant="embedded" prop if it's a BoilerplateInputs component
  const childrenWithVariant = useMemo(() => {
    if (!children) return null;
    
    // If children is a valid React element, clone it with variant prop
    if (isValidElement(children)) {
      return cloneElement(children, { variant: 'embedded' } as Record<string, unknown>);
    }
    
    return children;
  }, [children]);

  const [skipCommand, setSkipCommand] = useState(false);

  // State for controlling ViewSourceCode
  const [showSourceCode, setShowSourceCode] = useState(false);
  
  // Ref for scrolling to ViewSourceCode section
  const viewSourceCodeRef = useRef<HTMLDivElement>(null);

  // Get visual styling based on status
  const getStatusClasses = () => {
    if (skipCommand) return 'bg-gray-100 border-gray-200'
    
    const statusMap = {
      success: 'bg-green-50 border-green-200',
      fail: 'bg-red-50 border-red-200',
      running: 'bg-blue-50 border-blue-200',
      pending: 'bg-gray-100 border-gray-200',
      warn: 'bg-yellow-50 border-yellow-300' // Should not happen for Command, but include for type safety
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
    if (skipCommand) return 'text-gray-300'
    
    const colorMap = {
      success: 'text-green-600',
      fail: 'text-red-600',
      running: 'text-blue-600',
      pending: 'text-gray-500',
      warn: 'text-yellow-600' // Should not happen for Command
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

  // Early return for file errors - show only error message
  if (getFileError) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4" />
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
  if (requiredVariables.length > 0 && !boilerplateInputsId && !inlineInputsId) {
    return (
      <div className="relative rounded-sm border bg-yellow-50 border-yellow-200 mb-5 p-4">
        <div className="flex items-center text-yellow-700">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong><br />
            This command requires variables ({requiredVariables.join(', ')}) but no BoilerplateInputs component is configured. 
            Please add either:
            <ul className="list-disc ml-6 mt-2">
              <li>An inline <code className="bg-yellow-100 px-1 rounded">{"<BoilerplateInputs>"}</code> component as a child</li>
              <li>A <code className="bg-yellow-100 px-1 rounded">boilerplateInputsId</code> prop referencing an existing BoilerplateInputs</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }
  
  // Determine if the Run button should be disabled
  const isRunDisabled = 
    skipCommand || 
    commandStatus === 'running' || 
    isRendering ||
    (requiredVariables.length > 0 && !hasAllRequiredVariables);

  // Main render
  return (
    <div className={`relative rounded-sm border ${statusClasses} mb-5 p-4`}>      
      {/* Skip overlay */}
      {skipCommand && (
        <div className="absolute inset-0 bg-gray-500/20 border-2 border-gray-200 rounded-sm z-10"></div>
      )}

      {/* Command main container */}
      <div className="flex @container">
        <div className="border-r border-gray-300 pr-2 mr-4">
          <IconComponent className={`size-6 ${iconClasses} mr-1 ${commandStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="">

        {skipCommand && (
          <div className="mb-3 text-sm text-gray-800 bg-gray-300 w-fit p-3 flex items-center gap-2">
            <CircleSlash className="size-4" />
            This command has been skipped.
          </div>
        )}
        
        {/* Command main body */}
        <div className={`flex-1 space-y-2 ${skipCommand ? 'opacity-40' : ''}`}>
          {commandStatus === 'pending' && command && !title && (
            <div className="text-gray-600 font-semibold text-sm">Run a command</div>
          )}
          {commandStatus === 'pending' && !command && path && !title && (
            <div className="text-gray-600 font-semibold text-sm">Run a script</div>
          )}
          
          {/* Title and description */}
          {title && (
            <div className="text-md font-bold text-gray-600">
              <InlineMarkdown>{title}</InlineMarkdown>
            </div>
          )}
          {description && (
            <div className="text-md text-gray-600 mb-3">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}

          {commandStatus === 'success' && successMessage && (
            <div className="text-green-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{successMessage}</InlineMarkdown>
            </div>
          )}
          {commandStatus === 'fail' && failMessage && (
            <div className="text-red-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{failMessage}</InlineMarkdown>
            </div>
          )}
          {commandStatus === 'running' && runningMessage && (
            <div className="text-blue-600 font-semibold text-sm mb-3">
              <InlineMarkdown>{runningMessage}</InlineMarkdown>
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
            <div className="text-xs text-gray-600 flex items-center flex-wrap gap-3 mb-2">
              <span className="inline-flex items-center gap-1">
                <span className="font-semibold">Language:</span>
                <span className="font-mono bg-gray-100 rounded">{scriptMetadata.language}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="font-semibold">Lines:</span>
                <span className="font-mono">{scriptMetadata.lines}</span>
              </span>
              {path && (
                <span className="inline-flex items-center gap-1 text-gray-500">
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
                className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
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
          <div className="border-b border-gray-300"></div>
          
          {/* Show status messages for waiting/rendering/error states */}      
          {requiredVariables.length > 0 && !hasAllRequiredVariables && !isRendering && (
            <div className="mb-3 text-sm text-yellow-700 flex items-center gap-2">
              <AlertTriangle className="size-4" />
              You can run the command once we have values for the following variables: {requiredVariables.filter(varName => {
                const value = collectedVariables[varName];
                return value === undefined || value === null || value === '';
              }).map(varName => formatVariableLabel(varName)).join(', ')}
            </div>
          )}
          
          {renderError && (
            <div className="mb-3 text-sm text-red-600 flex items-start gap-2">
              <XCircle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Command render error:</strong> {renderError.message}
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
        <div className={`@md:absolute @md:top-4 @md:right-4 flex items-center gap-2 self-start z-20` + (commandStatus === 'success' ? ' text-gray-300' : '')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox 
              className="bg-white" 
              checked={skipCommand} 
              disabled={commandStatus === 'success'}
              onCheckedChange={(checked) => setSkipCommand(checked === true)} 
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
            status={commandStatus}
            autoOpen={commandStatus === 'running'}
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


export default Command;

