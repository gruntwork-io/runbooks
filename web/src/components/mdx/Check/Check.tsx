import { CircleQuestionMark, CircleSlash, CheckCircle, AlertTriangle, XCircle, Loader2, Square } from "lucide-react"
import { useState, useRef, useEffect } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ViewSourceCode } from "./components/ViewSourceCode"
import { ViewLogs } from "./components/ViewLogs"
import { useGetFile } from "@/hooks/useApiGetFile"

interface CheckProps {
  id: string
  path?: string
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline boilerplate.yml content  
}

function Check({
  id,
  path,
  successMessage = "Success",
  warnMessage = "Warning",
  failMessage = "Failed",
  runningMessage = "Checking...",
}: CheckProps) {
  // Suppress unused parameter warnings for future use
  void id;
  // Load file content if path is provided
  const { data: fileData, error: getFileError } = useGetFile(path || '')
  
  // Use file content if available, otherwise fall back to empty string
  const sourceCode = fileData?.content || ''
  
  const [skipCheck, setSkipCheck] = useState(false);
  const [checkStatus, setCheckStatus] = useState<'success' | 'warn' | 'fail' | 'running' | 'pending'>('pending');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logIntervalRef = useRef<NodeJS.Timeout | null>(null);

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
          <div className="text-md"><strong>{getFileError.message}.</strong> Failed to load file at {path}. Does the file exist?</div>
        </div>
      </div>
    )
  }

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
          <div className="flex items-center w-full justify-between">
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                disabled={skipCheck || checkStatus === 'running'}
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
        <div className="@md:absolute @md:top-4 @md:right-4 flex items-center gap-2 self-start z-20">
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
          fileName="Check Script"
        />
      </div>
    </div>
  )
}


export default Check;