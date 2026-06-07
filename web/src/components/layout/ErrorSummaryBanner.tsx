import { AlertTriangle, XCircle, Copy, Check } from 'lucide-react'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { ReportedError } from '../../contexts/ErrorReportingContext.types'

interface ErrorSummaryBannerProps {
  errors: ReportedError[]
  errorCount: number
  warningCount: number
  className?: string
}

/**
 * A compact banner that summarizes the number of errors and warnings in a runbook.
 * Prompts users to scroll down to see them inline in each component.
 */
export function ErrorSummaryBanner({ errors, errorCount, warningCount, className = '' }: ErrorSummaryBannerProps) {
  const { didCopy: copied, copy: doCopy } = useCopyToClipboard(2000)
  const totalIssues = errorCount + warningCount

  if (totalIssues === 0) {
    return null
  }

  // Determine banner style based on whether there are errors
  const hasErrors = errorCount > 0
  const bgColor = hasErrors ? 'bg-destructive-muted' : 'bg-warning-muted'
  const borderColor = hasErrors ? 'border-destructive/30' : 'border-warning/30'
  const textColor = hasErrors ? 'text-destructive' : 'text-warning-foreground'

  const handleCopy = () => {
    const text = errors.map(e => `[${e.componentType}] ${e.message}`).join('\n')
    void doCopy(text)
  }

  return (
    <div className={`${bgColor} ${borderColor} border rounded-lg p-4 ${className}`}>
      <div className="flex items-center justify-center gap-6">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${textColor}`}>
            This runbook has issues:
          </span>
        </div>

        <div className="flex items-center gap-4 text-sm">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="size-4" />
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-warning-foreground">
              <AlertTriangle className="size-4" />
              {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
            </span>
          )}
        </div>

        <button
          onClick={handleCopy}
          className={`flex items-center gap-1 text-sm px-2 py-1 rounded transition-colors ${
            copied
              ? 'text-success bg-success-muted'
              : `${textColor} hover:bg-black/5 cursor-pointer`
          }`}
          title="Copy all errors to clipboard"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied!' : 'Copy'}
        </button>

        <div className={`flex items-center gap-1 text-sm ${textColor} opacity-75`}>
          Scroll down to see details.
        </div>
      </div>
    </div>
  )
}
