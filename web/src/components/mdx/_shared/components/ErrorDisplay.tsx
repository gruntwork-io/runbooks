import React from "react"
import type { AppError } from "@/types/error"
import { issueAnchor } from "@/contexts/ErrorReportingContext.types"

interface ErrorDisplayProps {
  error: AppError
  /** The componentId the error is reported under, when it is, so the error summary can go to it. */
  issueId?: string | undefined
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ error, issueId }) => {
  return (
    <div
      {...issueAnchor(issueId)}
      data-testid="component-error"
      className="p-6 bg-destructive-muted border border-destructive/30 rounded-lg"
    >
      <div className="text-destructive font-semibold mb-2">Error: {error.message}</div>
      {error.details && <div className="text-destructive text-sm mb-3">{error.details}</div>}
    </div>
  )
}
