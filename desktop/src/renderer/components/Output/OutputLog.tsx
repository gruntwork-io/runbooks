import React, { useEffect, useRef } from 'react'
import type { LogEntry } from '../../../shared/types'

interface OutputLogProps {
  logs: LogEntry[]
}

export function OutputLog({ logs }: OutputLogProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  if (logs.length === 0) return null

  return (
    <div className="bg-neutral-900 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-neutral-800 text-xs font-medium text-neutral-400 uppercase tracking-wider">
        Execution Log
      </div>
      <div className="p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-0.5">
        {logs.map((entry, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-neutral-600 flex-shrink-0">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <LogLevel level={entry.level} />
            <span
              className={
                entry.level === 'error'
                  ? 'text-red-400'
                  : entry.level === 'warn'
                    ? 'text-amber-400'
                    : 'text-neutral-300'
              }
            >
              {entry.message}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function LogLevel({ level }: { level: string }) {
  const colors: Record<string, string> = {
    info: 'text-blue-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
    debug: 'text-neutral-500',
  }

  return (
    <span className={`${colors[level] || 'text-neutral-400'} w-12 flex-shrink-0 uppercase`}>
      {level}
    </span>
  )
}
