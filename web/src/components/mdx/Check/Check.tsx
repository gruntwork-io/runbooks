import { CircleQuestionMark, CircleSlash, CheckCircle, AlertTriangle, XCircle, Loader2, Square, ChevronDown, ChevronRight, Code, FileText } from "lucide-react"
import { useState, useRef, useEffect } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SquareTerminal } from "lucide-react"
import { CodeFile } from "@/components/artifacts/code/CodeFile"

interface CheckProps {
  id: string
  path?: string
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  children?: ReactNode // For inline boilerplate.yml content  
}

function Check({
  id,
  path,
  successMessage,
  warnMessage,
  failMessage,
}: CheckProps) {
  // Suppress unused parameter warnings for future use
  void id;
  void path;
  void successMessage;
  void warnMessage;
  void failMessage;
  
  const [skipCheck, setSkipCheck] = useState(false);
  const [checkStatus, setCheckStatus] = useState<'success' | 'warn' | 'fail' | 'in-progress' | 'pending'>('pending');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showSourceCode, setShowSourceCode] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // const [formState, setFormState] = useState<BoilerplateConfig | null>(null);
  // const [shouldRender, setShouldRender] = useState(false);
  // const [renderFormData, setRenderFormData] = useState<Record<string, unknown>>({});
  
  // // Get the global file tree context
  // const { setFileTree } = useFileTree();
  
  // // Get the boilerplate variables context to share variables, config, and raw YAML with BoilerplateTemplate components
  // const { setVariables, setConfig, setYamlContent } = useBoilerplateVariables();
  
  // // Get the render coordinator for inline templates
  // const { renderAllForInputsId } = useBoilerplateRenderCoordinator();

  // // Extract boolean to avoid React element in dependency array
  // const hasChildren = Boolean(children);

  // // Validate props first - this is a component-level validation error
  // const validationError = useMemo((): AppError | null => {
  //   if (!id) {
  //     return {
  //       message: "The <BoilerplateInputs> component requires a non-empty 'id' prop.",
  //       details: "Please provide a unique 'id' for this component instance."
  //     }
  //   }

  //   if (!templatePath && !hasChildren) {
  //     return {
  //       message: "Invalid <BoilerplateInputs> configuration.",
  //       details: "Please specify either a templatePath or inline boilerplate.yml content."
  //     }
  //   }

  //   if (templatePath && hasChildren) {
  //     return {
  //       message: "Invalid <BoilerplateInputs> configuration.",
  //       details: "You cannot both specify both a templatePath and inline boilerplate.yml content. Please provide only one."
  //     }
  //   }

  //   return null
  // }, [id, templatePath, hasChildren])

  // // Extract the contents of the children (inline boilerplate.yml content) if they are provided
  // const yamlExtraction = children ? extractYamlFromChildren(children) : { content: '', error: null }
  // const inlineYamlContent = yamlExtraction.content
  // const inlineContentError = yamlExtraction.error
  
  // // Only make API call if validation passes
  // const { data: boilerplateConfig, isLoading, error: apiError } = useApiGetBoilerplateConfig(
  //   templatePath, 
  //   inlineYamlContent,
  //   !validationError && !inlineContentError // shouldFetch is false when there's any validation error
  // );

  // // Apply the prefilled variables to the boilerplate config
  // const boilerplateConfigWithPrefilledVariables = useMemo(() => {
  //   if (!boilerplateConfig) return null
  //   return {
  //     ...boilerplateConfig,
  //     variables: boilerplateConfig.variables.map(variable => ({ 
  //       ...variable, 
  //       default: prefilledVariables[variable.name] ? String(prefilledVariables[variable.name]) : variable.default 
  //     }))
  //   }
  // }, [boilerplateConfig, prefilledVariables])
  
  // // Update form state when boilerplate config changes - use a ref to track if we've already set it
  // const hasSetFormState = useRef(false)
  // useEffect(() => {
  //   if (boilerplateConfigWithPrefilledVariables && !hasSetFormState.current) {
  //     setFormState(boilerplateConfigWithPrefilledVariables)
  //     hasSetFormState.current = true
  //   }
  // }, [boilerplateConfigWithPrefilledVariables])
  
  // // Store the boilerplate config and raw YAML in context so BoilerplateTemplate can access it
  // useEffect(() => {
  //   if (boilerplateConfig) {
  //     setConfig(id, boilerplateConfig)
  //     // Store the raw YAML content from the API response
  //     if (boilerplateConfig.rawYaml) {
  //       setYamlContent(id, boilerplateConfig.rawYaml)
  //     }
  //   }
  // }, [boilerplateConfig, id, setConfig, setYamlContent])

  // // Convert form state to initial data format
  // const initialData = useMemo(() => {
  //   if (!formState) return {}
  //   return formState.variables.reduce((acc, variable) => {
  //     acc[variable.name] = variable.default
  //     return acc
  //   }, {} as Record<string, unknown>)
  // }, [formState])

  // // Render API call - only triggered when shouldRender is true
  // const { data: renderResult, isLoading: isGenerating, error: renderError, isAutoRendering, autoRender } = useApiBoilerplateRender(
  //   templatePath || '',
  //   renderFormData,
  //   shouldRender && Boolean(templatePath)
  // )

  // // Update global file tree when render result is available
  // // Note: useApiBoilerplateRender already handles merging the file tree, but we keep this
  // // for backwards compatibility and to ensure the merge happens
  // useEffect(() => {
  //   if (renderResult && renderResult.fileTree) {
  //     // Cast the API response to match the expected type structure
  //     const fileTree = renderResult.fileTree as FileTreeNode[];
  //     setFileTree(currentFileTree => mergeFileTrees(currentFileTree, fileTree));
  //   }
  // }, [renderResult, setFileTree]);

  // // Debounce timer ref for auto-render
  // const autoRenderTimerRef = useRef<NodeJS.Timeout | null>(null);

  // // Handle auto-rendering when form data changes (debounced)
  // const handleAutoRender = useCallback((formData: Record<string, unknown>) => {
  //   if (!shouldRender) return; // Only auto-render after initial generation
    
  //   // Type guard: id is validated to be non-empty by validationError check
  //   const inputsId: string = id ?? '';
  //   if (!inputsId) return;
    
  //   console.log(`[BoilerplateInputs][${inputsId}] Auto-render requested (debouncing...)`);
    
  //   // Clear existing timer
  //   if (autoRenderTimerRef.current) {
  //     clearTimeout(autoRenderTimerRef.current);
  //   }
    
  //   // Debounce: wait 200ms after last change before updating
  //   autoRenderTimerRef.current = setTimeout(() => {
  //     console.log(`[BoilerplateInputs][${inputsId}] Auto-render executing`);
      
  //     // Update variables in context so BoilerplateTemplate components can re-render reactively
  //     setVariables(inputsId, formData);
      
  //     // If templatePath exists, also trigger file tree auto-render
  //     // (inline templates will auto-update via their reactive effect)
  //     if (templatePath) {
  //       autoRender(templatePath, formData);
  //     }
  //   }, 200);
  // }, [id, templatePath, shouldRender, autoRender, setVariables]);
  
  // // Cleanup timer on unmount
  // useEffect(() => {
  //   return () => {
  //     if (autoRenderTimerRef.current) {
  //       clearTimeout(autoRenderTimerRef.current);
  //     }
  //   };
  // }, []);

  // // Handle successful generation - trigger render API call
  // const handleGenerate = useCallback(async (formData: Record<string, unknown>) => {
  //   // Type guard: id is validated to be non-empty by validationError check
  //   const inputsId: string = id ?? '';
  //   if (!inputsId) {
  //     console.error(`[BoilerplateInputs] No inputsId provided!`);
  //     return;
  //   }
    
  //   console.log(`[BoilerplateInputs][${inputsId}] 🎯 Generate clicked with formData:`, formData);
  //   console.log(`[BoilerplateInputs][${inputsId}] templatePath:`, templatePath);
    
  //   // Publish variables to context (needed for both paths)
  //   console.log(`[BoilerplateInputs][${inputsId}] Publishing variables to context:`, formData);
  //   setVariables(inputsId, formData);
    
  //   // Path 1: File-based rendering (templatePath exists)
  //   if (templatePath) {
  //     console.log(`[BoilerplateInputs][${inputsId}] Using templatePath mode`);
  //     setRenderFormData(formData);
  //     setShouldRender(true);
  //   } 
  //   // Path 2: Inline template rendering (no templatePath, uses coordinator)
  //   else {
  //     console.log(`[BoilerplateInputs][${inputsId}] 🚀 Using coordinator for inline templates`);
  //     try {
  //       await renderAllForInputsId(inputsId, formData);
  //       console.log(`[BoilerplateInputs][${inputsId}] ✅ Coordinator render complete`);
  //       setShouldRender(true); // Mark as rendered for auto-updates
  //     } catch (error) {
  //       console.error(`[BoilerplateInputs][${inputsId}] ❌ Coordinator render failed:`, error);
  //     }
  //   }

  //   // Call the original onGenerate callback if provided
  //   if (onGenerate) {
  //     onGenerate(formData);
  //   }
  // }, [id, templatePath, setVariables, renderAllForInputsId, onGenerate])

  // // Early return for loading states
  // if (isLoading) {
  //   return <LoadingDisplay message="Loading boilerplate configuration..." />
  // }
  
  // // Early return for validation errors (highest priority)
  // if (validationError) {
  //   return <ErrorDisplay error={validationError} />
  // }

  // // Early return for inline content format errors
  // if (inlineContentError) {
  //   return <ErrorDisplay error={inlineContentError} />
  // }

  // // Early return for API errors
  // if (apiError) {
  //   return <ErrorDisplay error={apiError} />
  // }

  // // Early return for render errors
  // if (renderError) {
  //   return <ErrorDisplay error={renderError} />
  // }

  // Get visual styling based on status
  const getStatusClasses = () => {
    if (skipCheck) return 'bg-gray-100 border-gray-200'
    
    const statusMap = {
      success: 'bg-green-50 border-green-200',
      warn: 'bg-yellow-50 border-yellow-200', 
      fail: 'bg-red-50 border-red-200',
      'in-progress': 'bg-blue-50 border-blue-200',
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
      'in-progress': Loader2,
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
      'in-progress': 'text-blue-600',
      pending: 'text-gray-500'
    }
    return colorMap[checkStatus]
  }

  const statusClasses = getStatusClasses()
  const IconComponent = getStatusIcon()
  const iconClasses = getStatusIconClasses()

  // Sample script content
  const sourceCode = `#!/bin/bash

# KMS Key Validation Script
# This script checks if your KMS key is properly configured

set -e

echo "🔍 Starting KMS key validation..."

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed"
    exit 1
fi

# Check if key ID is provided
if [ -z "$KMS_KEY_ID" ]; then
    echo "❌ KMS_KEY_ID environment variable is not set"
    exit 1
fi

echo "🔑 Validating KMS key: $KMS_KEY_ID"

# Check if key exists and is accessible
if aws kms describe-key --key-id "$KMS_KEY_ID" > /dev/null 2>&1; then
    echo "✅ KMS key exists and is accessible"
else
    echo "❌ KMS key not found or not accessible"
    exit 1
fi

# Check key policy
echo "📋 Checking key policy..."
KEY_POLICY=$(aws kms get-key-policy --key-id "$KMS_KEY_ID" --policy-name default --query 'Policy' --output text)

if echo "$KEY_POLICY" | grep -q "arn:aws:iam::*:root"; then
    echo "✅ Key policy allows root access"
else
    echo "⚠️  Key policy may not allow root access"
fi

# Test encryption/decryption
echo "🔐 Testing encryption/decryption..."
TEST_DATA="test-data-$(date +%s)"
ENCRYPTED=$(aws kms encrypt --key-id "$KMS_KEY_ID" --plaintext "$TEST_DATA" --query 'CiphertextBlob' --output text)

if [ -n "$ENCRYPTED" ]; then
    echo "✅ Encryption successful"
    
    # Test decryption
    DECRYPTED=$(aws kms decrypt --ciphertext-blob "$ENCRYPTED" --query 'Plaintext' --output text | base64 -d)
    
    if [ "$DECRYPTED" = "$TEST_DATA" ]; then
        echo "✅ Decryption successful"
        echo "🎉 KMS key validation completed successfully!"
    else
        echo "❌ Decryption failed"
        exit 1
    fi
else
    echo "❌ Encryption failed"
    exit 1
fi`

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
    setCheckStatus('in-progress')
    setLogs([])
    setShowLogs(true) // Auto-open logs when check starts
    
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

  // Main render - form with success indicator overlay if needed
  return (
    <div className={`relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* Skip overlay */}
      {skipCheck && (
        <div className="absolute inset-0 bg-gray-500/20 border-2 border-gray-200 rounded-sm z-10"></div>
      )}
      
      <div className="flex">
        <div className="border-r border-gray-300 pr-2 mr-4">
          <IconComponent className={`size-6 ${iconClasses} mr-1 ${checkStatus === 'in-progress' ? 'animate-spin' : ''}`} />
        </div>
        <div className={`flex-1 space-y-2 ${skipCheck ? 'opacity-50' : ''}`}>
          <div className={`text-md font-bold text-gray-600`}>Did you set up your KMS key correctly?</div>
          <div className="text-md text-gray-600 mb-3">Sometimes users copy & paste the wrong key ID, or forget to attach the correct IAM policy.
            Let's make sure it's all set up correctly.
          </div>
          <div className="flex items-center w-full justify-between">
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                disabled={skipCheck || checkStatus === 'in-progress'}
                onClick={handleStartCheck}
              >
                {checkStatus === 'in-progress' ? 'Checking...' : 'Check'}
              </Button>
              {checkStatus === 'in-progress' && (
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
        <div className="absolute top-4 right-4 flex items-center gap-2 z-20">
          <Checkbox id="skip-check" className="bg-white cursor-pointer" checked={skipCheck} onCheckedChange={(checked) => setSkipCheck(checked === true)} />
          <label htmlFor="skip-check" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer select-none">
            Skip
          </label>
        </div>
      </div>

      {/* Expandable sections inside the main box */}
      <div className="mt-4 space-y-2">
        {/* View Source Code section */}
        <div className="border border-gray-200 rounded-sm">
          <button
            onClick={() => setShowSourceCode(!showSourceCode)}
            className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
          >
            {showSourceCode ? (
              <ChevronDown className="size-4 text-gray-500" />
            ) : (
              <ChevronRight className="size-4 text-gray-500" />
            )}
            <FileText className="size-4 text-gray-600" />
            <span className="text-sm text-gray-700">View Source Code</span>
          </button>
          {showSourceCode && (
            <div className="border-t border-gray-200 p-3 bg-gray-50">
              <CodeFile
                fileName="Check Script"
                filePath={path}
                code={sourceCode}
              />
            </div>
          )}
        </div>

        {/* View Logs section */}
        <div className="border border-gray-200 rounded-sm">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
          >
            {showLogs ? (
              <ChevronDown className="size-4 text-gray-500" />
            ) : (
              <ChevronRight className="size-4 text-gray-500" />
            )}
            <SquareTerminal className="size-4 text-gray-600" />
            <span className="text-sm text-gray-700">View Logs</span>
          </button>
          {showLogs && (
            <div className="border-t border-gray-200 p-3 bg-gray-900 max-h-64 overflow-y-auto">
              {logs.length === 0 ? (
                <div className="text-sm text-gray-400 italic">
                  No logs yet. Click "Check" to start the validation process.
                </div>
              ) : (
                <div className="space-y-1">
                  {logs.map((log, index) => (
                    <div key={index} className="text-xs font-mono text-gray-100">
                      <span className="text-gray-500 mr-2">
                        {new Date().toLocaleTimeString()}
                      </span>
                      {log}
                    </div>
                  ))}
                  {checkStatus === 'in-progress' && (
                    <div className="text-xs font-mono text-gray-400 animate-pulse">
                      <span className="text-gray-600 mr-2">
                        {new Date().toLocaleTimeString()}
                      </span>
                      Running...
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


export default Check;