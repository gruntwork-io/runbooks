import { createContext } from "react"

export type ErrorSeverity = "error" | "warning"

export interface ReportedError {
  componentId: string
  componentType: string
  severity: ErrorSeverity
  message: string
}

export interface ErrorReportingContextValue {
  errors: ReportedError[]
  errorCount: number
  warningCount: number
  reportError: (error: ReportedError) => void
  clearError: (componentId: string) => void
  clearAllErrors: () => void
}

export const ErrorReportingContext = createContext<ErrorReportingContextValue | undefined>(
  undefined,
)

/**
 * Marks the element that shows a reported error, so the error summary can
 * take the user to it. The value is the error's componentId, or the ids of
 * several errors the element shows, separated by spaces.
 */
export const ISSUE_ATTRIBUTE = "data-runbook-issue"

/**
 * The attribute to spread onto the element that shows the reported errors
 * with these ids. An id given as false or nothing, for an error the element
 * isn't showing, is left out, and with no ids left, so is the attribute.
 */
export function issueAnchor(...componentIds: (string | false | null | undefined)[]): {
  [ISSUE_ATTRIBUTE]?: string
} {
  const ids = componentIds.filter((id) => typeof id === "string" && id !== "")
  return ids.length > 0 ? { [ISSUE_ATTRIBUTE]: ids.join(" ") } : {}
}
