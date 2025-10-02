import { CircleQuestionMark, CircleSlash, CheckCircle, AlertTriangle, XCircle, Loader2, Square } from "lucide-react"
import { useState, useRef, useEffect, useMemo, useCallback, cloneElement, isValidElement } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ViewSourceCode } from "./components/ViewSourceCode"
import { ViewLogs } from "./components/ViewLogs"
import { useGetFile } from "@/hooks/useApiGetFile"
import { useBoilerplateVariables } from "@/contexts/useBoilerplateVariables"
import { extractInlineInputsId } from "./lib/extractInlineInputsId"
import { extractTemplateVariables } from "@/components/mdx/BoilerplateTemplate/lib/extractTemplateVariables"
import { formatVariableLabel } from "@/components/mdx/BoilerplateInputs/lib/formatVariableLabel"

interface CheckProps {
  id: string
  path?: string
  boilerplateInputsId?: string
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline BoilerplateInputs component
}

function Check({
  id,
  path,
  boilerplateInputsId,
  successMessage = "Success",
  warnMessage = "Warning",
  failMessage = "Failed",
  runningMessage = "Checking...",
  children,
}: CheckProps) {
  // Suppress unused parameter warnings for future use
  void id;
  // Load file content if path is provided
  const { data: fileData, error: getFileError } = useGetFile(path || '')
  
  // Use file content if available, otherwise fall back to empty string
  const rawScriptContent = fileData?.content || ''
  const language = fileData?.language
  
  // Get boilerplate variables context for variable collection
  const { variablesByInputsId, yamlContentByInputsId } = useBoilerplateVariables();
  
  // Extract inline BoilerplateInputs ID from children if present
  const inlineInputsId = useMemo(() => extractInlineInputsId(children), [children]);
  
  // Collect variables from both sources and merge (inline takes precedence)
  const collectedVariables = useMemo(() => {
    const externalVars = boilerplateInputsId ? variablesByInputsId[boilerplateInputsId] : undefined;
    const inlineVars = inlineInputsId ? variablesByInputsId[inlineInputsId] : undefined;
    
    // Merge: inline overrides external
    return {
      ...(externalVars || {}),
      ...(inlineVars || {})
    };
  }, [boilerplateInputsId, inlineInputsId, variablesByInputsId]);
  
  // Extract template variables from script content
  const requiredVariables = useMemo(() => {
    return extractTemplateVariables(rawScriptContent);
  }, [rawScriptContent]);
  
  // Check if we have all required variables
  const hasAllRequiredVariables = useMemo(() => {
    if (requiredVariables.length === 0) return true; // No variables needed
    
    return requiredVariables.every(varName => {
      const value = collectedVariables[varName];
      return value !== undefined && value !== null && value !== '';
    });
  }, [requiredVariables, collectedVariables]);
  
  // State for rendered script content
  const [renderedScript, setRenderedScript] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  
  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null);
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Determine the actual script content to use
  const sourceCode = renderedScript !== null ? renderedScript : rawScriptContent;
  
  // Clone children and add variant="embedded" prop if it's a BoilerplateInputs component
  const childrenWithVariant = useMemo(() => {
    if (!children) return null;
    
    // If children is a valid React element, clone it with variant prop
    if (isValidElement(children)) {
      return cloneElement(children, { variant: 'embedded' } as Record<string, unknown>);
    }
    
    return children;
  }, [children]);
  
  const [skipCheck, setSkipCheck] = useState(false);
  const [checkStatus, setCheckStatus] = useState<'success' | 'warn' | 'fail' | 'running' | 'pending'>('pending');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Function to render script with variables
  const renderScript = useCallback(async (variables: Record<string, unknown>) => {
    setIsRendering(true);
    setRenderError(null);
    
    // Get the boilerplate.yml content from context
    // Try inline first, then external
    const inputsIdToUse = inlineInputsId || boilerplateInputsId;
    const boilerplateYaml = inputsIdToUse ? yamlContentByInputsId[inputsIdToUse] : undefined;
    
    // Build template files object - must include boilerplate.yml
    const templateFiles: Record<string, string> = {
      // 'script.sh' is just a filename identifier for the API request/response
      // Each API call is isolated, so no risk of collision between Check components
      'script.sh': rawScriptContent
    };
    
    if (boilerplateYaml) {
      templateFiles['boilerplate.yml'] = boilerplateYaml;
    }
    
    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateFiles,
          variables
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        setRenderError(errorData?.error || 'Failed to render script');
        setIsRendering(false);
        return;
      }

      const responseData = await response.json();
      const renderedFiles = responseData.renderedFiles;
      
      if (renderedFiles && renderedFiles['script.sh']) {
        setRenderedScript(renderedFiles['script.sh'].content);
      }
      
      setIsRendering(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setRenderError(errorMessage);
      setIsRendering(false);
    }
  }, [rawScriptContent, inlineInputsId, boilerplateInputsId, yamlContentByInputsId]);
  
  // Auto-update when variables change (debounced)
  useEffect(() => {
    // Only render if we have template variables and all required variables are available
    if (requiredVariables.length === 0) {
      // No template variables, use raw script
      setRenderedScript(null);
      return;
    }
    
    if (!hasAllRequiredVariables) {
      // Required variables not available yet
      return;
    }
    
    // Check if variables actually changed
    const variablesKey = JSON.stringify(collectedVariables);
    if (variablesKey === lastRenderedVariablesRef.current) {
      return;
    }
    
    // Clear existing timer
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current);
    }
    
    // Debounce: wait 300ms after last change before rendering
    autoUpdateTimerRef.current = setTimeout(() => {
      lastRenderedVariablesRef.current = variablesKey;
      renderScript(collectedVariables);
    }, 300);
  }, [collectedVariables, requiredVariables.length, hasAllRequiredVariables, renderScript]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current);
      }
    };
  }, []);

  // Get visual styling based on status
  const getStatusClasses = () => {
    if (skipCheck) return 'bg-gray-100 border-gray-200'
    
    const statusMap = {
      success: 'bg-green-50 border-green-200',
      warn: 'bg-yellow-50 border-yellow-200', 
      fail: 'bg-red-50 border-red-200',
      running: 'bg-blue-50 border-blue-200',
      pending: 'bg-gray-100 border-gray-200'
    }
    
    return statusMap[checkStatus]
  }

  const getStatusIcon = () => {
    if (skipCheck) return CircleSlash
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
    if (skipCheck) return 'text-gray-400'
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


  // Sample log messages for simulation
  const sampleLogs = [
    "🔍 Starting KMS key validation...",
    "🔑 Validating KMS key: arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
    "✅ KMS key exists and is accessible",
    "📋 Checking key policy...",
    "✅ Key policy allows root access",
    "🔐 Testing encryption/decryption...",
    "✅ Encryption successful",
    "✅ Decryption successful",
    "🎉 KMS key validation completed successfully!"
  ];

  // Handle starting the check
  const handleStartCheck = () => {
    setCheckStatus('running')
    setLogs([])
    
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    
    // Clear any existing log interval
    if (logIntervalRef.current) {
      clearInterval(logIntervalRef.current)
    }
    
    // Simulate real-time logs
    let logIndex = 0
    logIntervalRef.current = setInterval(() => {
      if (logIndex < sampleLogs.length) {
        setLogs(prev => [...prev, sampleLogs[logIndex]])
        logIndex++
      } else {
        if (logIntervalRef.current) {
          clearInterval(logIntervalRef.current)
        }
      }
    }, 500)
    
    // Set success after 3 seconds
    timeoutRef.current = setTimeout(() => {
      setCheckStatus('success')
    }, 3000)
  }

  // Handle stopping the check
  const handleStopCheck = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (logIntervalRef.current) {
      clearInterval(logIntervalRef.current)
      logIntervalRef.current = null
    }
    setCheckStatus('pending')
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      if (logIntervalRef.current) {
        clearInterval(logIntervalRef.current)
      }
    }
  }, [])


  // Early return for file errors - show only error message
  if (getFileError) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4" />
          <div className="text-md">
            <strong>CheckComponent Error:</strong><br />{getFileError.message}. Failed to load file at {path}. Does the file exist? Do you have permission to read it?</div>
        </div>
      </div>
    )
  }
  
  // Check if script requires variables but none are configured
  if (requiredVariables.length > 0 && !boilerplateInputsId && !inlineInputsId) {
    return (
      <div className="relative rounded-sm border bg-yellow-50 border-yellow-200 mb-5 p-4">
        <div className="flex items-center text-yellow-700">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong><br />
            This check script requires variables ({requiredVariables.join(', ')}) but no BoilerplateInputs component is configured. 
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
        <div className={`flex-1 space-y-2 ${skipCheck ? 'opacity-50' : ''}`}>
          {checkStatus === 'success' && successMessage && (
            <div className="text-green-600 font-semibold text-sm">{successMessage}</div>
          )}
          {checkStatus === 'warn' && warnMessage && (
            <div className="text-yellow-600 font-semibold text-sm">{warnMessage}</div>
          )}
          {checkStatus === 'fail' && failMessage && (
            <div className="text-red-600 font-semibold text-sm">{failMessage}</div>
          )}
          {checkStatus === 'running' && runningMessage && (
            <div className="text-blue-600 font-semibold text-sm">{runningMessage}</div>
          )}
          <div className={`text-md font-bold text-gray-600`}>Did you set up your KMS key correctly?</div>
          <div className="text-md text-gray-600 mb-3">Sometimes users copy & paste the wrong key ID, or forget to attach the correct IAM policy.
            Let's make sure it's all set up correctly.
          </div>
          
          {/* Render inline BoilerplateInputs children if present */}
          {childrenWithVariant && (
            <div className="mb-4">
              {childrenWithVariant}
            </div>
          )}

          {/* Separator */}
          <div className="border-b border-gray-300"></div>
          
          {/* Show status messages for waiting/rendering/error states */}      
          {requiredVariables.length > 0 && !hasAllRequiredVariables && !isRendering && (
            <div className="mb-3 text-sm text-yellow-600 flex items-center gap-2">
              <AlertTriangle className="size-4" />
              You can run the check once have values for the following variables: {requiredVariables.filter(varName => {
                const value = collectedVariables[varName];
                return value === undefined || value === null || value === '';
              }).map(varName => formatVariableLabel(varName)).join(', ')}
            </div>
          )}
          
          {renderError && (
            <div className="mb-3 text-sm text-red-600 flex items-center gap-2">
              <XCircle className="size-4" />
              Script render error: {renderError}
            </div>
          )}
          
          <div className="flex items-center w-full justify-between">
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                disabled={isCheckDisabled}
                onClick={handleStartCheck}
              >
                {checkStatus === 'running' ? 'Checking...' : 'Check'}
              </Button>
              {checkStatus === 'running' && (
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleStopCheck}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Square className="size-4 mr-1" />
                  Stop
                </Button>
              )}
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
            checkStatus={checkStatus}
            autoOpen={checkStatus === 'running'}
          />
          <ViewSourceCode 
            sourceCode={sourceCode}
            path={path}
            language={language}
            fileName="Check Script"
          />
      </div>
    </div>
  )
}


export default Check;