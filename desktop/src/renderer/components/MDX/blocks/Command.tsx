import React, { useState, useCallback, useRef, useEffect } from 'react'

type CommandStatus = 'pending' | 'running' | 'success' | 'fail'

interface CommandProps {
  id: string
  title?: string
  description?: string
  path?: string
  command?: string
  successMessage?: string
  failMessage?: string
  runbookFolder: string
  children?: React.ReactNode
  [key: string]: unknown
}

export function Command({
  id,
  title,
  description,
  path,
  command,
  successMessage = 'Command completed successfully',
  failMessage = 'Command failed',
  runbookFolder,
}: CommandProps) {
  const [status, setStatus] = useState<CommandStatus>('pending')
  const [output, setOutput] = useState('')
  const [showOutput, setShowOutput] = useState(false)
  const executionIdRef = useRef<string | null>(null)

  useEffect(() => {
    const cleanupOutput = window.runbooks.onScriptOutput((event) => {
      if (event.executionId === executionIdRef.current) {
        setOutput((prev) => prev + event.data)
      }
    })

    const cleanupExit = window.runbooks.onScriptExit((event) => {
      if (event.executionId === executionIdRef.current) {
        setStatus(event.exitCode === 0 ? 'success' : 'fail')
        executionIdRef.current = null
      }
    })

    return () => {
      cleanupOutput()
      cleanupExit()
    }
  }, [])

  const handleRun = useCallback(async () => {
    setStatus('running')
    setOutput('')
    setShowOutput(true)

    const execId = `cmd-${id}-${Date.now()}`
    executionIdRef.current = execId

    let script = command || ''
    if (path && !command) {
      try {
        const file = await window.runbooks.readFile({
          relativePath: path,
          runbookFolder,
        })
        script = file.content
      } catch (err) {
        setOutput(`Error loading script: ${err instanceof Error ? err.message : String(err)}`)
        setStatus('fail')
        return
      }
    }

    try {
      await window.runbooks.executeScript({
        executionId: execId,
        script,
        cwd: runbookFolder,
      })
    } catch (err) {
      setOutput(`Error executing: ${err instanceof Error ? err.message : String(err)}`)
      setStatus('fail')
    }
  }, [id, path, command, runbookFolder])

  const handleCancel = useCallback(() => {
    if (executionIdRef.current) {
      window.runbooks.cancelScript(executionIdRef.current)
    }
  }, [])

  const statusConfig = {
    pending: { bg: 'bg-neutral-50', border: 'border-neutral-200', icon: '\u25B6', iconColor: 'text-neutral-400' },
    running: { bg: 'bg-blue-50', border: 'border-blue-200', icon: '...', iconColor: 'text-blue-500' },
    success: { bg: 'bg-green-50', border: 'border-green-200', icon: '\u2713', iconColor: 'text-green-600' },
    fail: { bg: 'bg-red-50', border: 'border-red-200', icon: '\u2717', iconColor: 'text-red-600' },
  }

  const cfg = statusConfig[status]

  return (
    <div className={`relative rounded-lg border ${cfg.border} ${cfg.bg} p-4 mb-4`}>
      <div className="flex items-start gap-3">
        <div className={`text-lg font-bold ${cfg.iconColor} w-6 text-center flex-shrink-0 ${status === 'running' ? 'animate-pulse' : ''}`}>
          {cfg.icon}
        </div>
        <div className="flex-1 min-w-0">
          {title && <div className="font-semibold text-neutral-800 text-sm">{title}</div>}
          {description && <div className="text-sm text-neutral-600 mt-0.5">{description}</div>}

          {status === 'success' && (
            <div className="text-sm text-green-700 font-medium mt-2">{successMessage}</div>
          )}
          {status === 'fail' && (
            <div className="text-sm text-red-700 font-medium mt-2">{failMessage}</div>
          )}

          {/* Inline command display */}
          {command && !path && (
            <div className="mt-2 bg-neutral-900 rounded p-2 text-xs font-mono text-neutral-100 whitespace-pre-wrap">
              {command}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleRun}
              disabled={status === 'running'}
              className="px-3 py-1 text-xs font-medium rounded-md border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === 'running' ? 'Running...' : 'Run'}
            </button>
            {status === 'running' && (
              <button
                onClick={handleCancel}
                className="px-3 py-1 text-xs font-medium rounded-md border border-red-300 text-red-600 hover:bg-red-50"
              >
                Stop
              </button>
            )}
          </div>

          {/* Output log */}
          {output && (
            <div className="mt-3">
              <button
                onClick={() => setShowOutput(!showOutput)}
                className="text-xs text-neutral-500 hover:text-neutral-700"
              >
                {showOutput ? '\u25BC' : '\u25B6'} Output
              </button>
              {showOutput && (
                <pre className="mt-1 bg-neutral-900 rounded p-2 text-xs font-mono text-neutral-100 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {output}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="absolute top-2 right-2 text-[10px] font-mono text-neutral-400 bg-white/60 px-1 rounded">
        {id}
      </div>
    </div>
  )
}
