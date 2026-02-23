import React from 'react'

interface AdmonitionProps {
  type?: 'info' | 'warning' | 'error' | 'success' | 'tip'
  title?: string
  description?: string
  children?: React.ReactNode
  [key: string]: unknown
}

const typeConfig = {
  info: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-800', icon: '\u2139\uFE0F' },
  warning: { bg: 'bg-yellow-50', border: 'border-yellow-300', text: 'text-yellow-800', icon: '\u26A0\uFE0F' },
  error: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800', icon: '\u274C' },
  success: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-800', icon: '\u2705' },
  tip: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-800', icon: '\uD83D\uDCA1' },
}

export function Admonition({ type = 'info', title, description, children }: AdmonitionProps) {
  const cfg = typeConfig[type] || typeConfig.info

  return (
    <div className={`rounded-lg border ${cfg.border} ${cfg.bg} p-4 mb-4`}>
      {title && (
        <div className={`font-semibold text-sm ${cfg.text} mb-1`}>
          {cfg.icon} {title}
        </div>
      )}
      {description && (
        <div className={`text-sm ${cfg.text} opacity-80`}>{description}</div>
      )}
      {children && (
        <div className={`text-sm ${cfg.text} opacity-80 mt-1`}>{children}</div>
      )}
    </div>
  )
}
