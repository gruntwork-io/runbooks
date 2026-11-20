import { useRef, useState } from "react"
import { AlertTriangle, XCircle, Copy, Check } from "lucide-react"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { useRevealElement } from "@/contexts/useRunbookChapters"
import {
  ISSUE_ATTRIBUTE,
  type ErrorSeverity,
  type ReportedError,
} from "../../contexts/ErrorReportingContext.types"

interface ErrorSummaryBannerProps {
  errors: ReportedError[]
  errorCount: number
  warningCount: number
  className?: string
}

/** Where the details link last went: the nth of the places on the page that show the issues. */
interface Shown {
  position: number
  total: number
  /** How many issues there were then, so the count is dropped once that changes. */
  issues: number
}

/**
 * A compact banner that summarizes the number of errors and warnings in a runbook.
 * Its details link scrolls to where each one shows inline, the next one on
 * each click, in page order, and back to the first after the last.
 */
export function ErrorSummaryBanner({
  errors,
  errorCount,
  warningCount,
  className = "",
}: ErrorSummaryBannerProps) {
  const { didCopy: copied, copy: doCopy } = useCopyToClipboard(2000)
  const revealElement = useRevealElement()
  // The element the link went to last, so the next click goes to the one after it
  const lastShownRef = useRef<Element | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const totalIssues = errorCount + warningCount

  if (totalIssues === 0) {
    return null
  }

  // Determine banner style based on whether there are errors
  const hasErrors = errorCount > 0
  const bgColor = hasErrors ? "bg-destructive-muted" : "bg-warning-muted"
  const borderColor = hasErrors ? "border-destructive/30" : "border-warning/30"
  const textColor = hasErrors ? "text-destructive" : "text-warning-foreground"

  const handleCopy = () => {
    const text = errors.map((e) => `[${e.componentType}] ${e.message}`).join("\n")
    void doCopy(text)
  }

  const showNext = () => {
    const targets = issueElements(errors)
    const index = nextIndex(targets, lastShownRef.current)
    const target = targets[index]
    if (!target) return
    lastShownRef.current = target
    revealElement(target)
    flash(target, severityShownBy(target, errors))
    setShown({ position: index + 1, total: targets.length, issues: totalIssues })
  }

  // Once the link has gone to one of several, it counts them
  const cycling = shown !== null && shown.total > 1 && shown.issues === totalIssues

  return (
    <div className={`${bgColor} ${borderColor} border rounded-lg p-4 ${className}`}>
      <div className="flex items-center justify-center gap-6">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${textColor}`}>This runbook has issues:</span>
        </div>

        <div className="flex items-center gap-4 text-sm">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="size-4" />
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-warning-foreground">
              <AlertTriangle className="size-4" />
              {warningCount} {warningCount === 1 ? "warning" : "warnings"}
            </span>
          )}
        </div>

        <button
          onClick={handleCopy}
          className={`flex items-center gap-1 text-sm px-2 py-1 rounded transition-colors ${
            copied
              ? "text-success bg-success-muted"
              : `${textColor} hover:bg-black/5 cursor-pointer`
          }`}
          title="Copy all errors to clipboard"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied!" : "Copy"}
        </button>

        <div className={`flex items-center gap-2 text-sm ${textColor}`}>
          {cycling && (
            <span className="opacity-75 tabular-nums">
              {shown.position} of {shown.total}
            </span>
          )}
          <button
            type="button"
            onClick={showNext}
            className="underline underline-offset-2 cursor-pointer hover:opacity-80"
            title="Scroll to where the next error or warning shows"
          >
            {cycling ? "Next issue" : "Show details"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The ids of the reported errors an element shows. */
function idsShownBy(element: Element): string[] {
  return (element.getAttribute(ISSUE_ATTRIBUTE) ?? "").split(" ")
}

/** The elements that show these errors, in page order. */
function issueElements(errors: ReportedError[]): Element[] {
  const ids = new Set(errors.map((e) => e.componentId))
  return Array.from(document.querySelectorAll(`[${ISSUE_ATTRIBUTE}]`)).filter((element) =>
    idsShownBy(element).some((id) => ids.has(id)),
  )
}

/**
 * The index of the first target after the one shown last, or of the first
 * target when none follows it, or nothing was shown, or what was is gone.
 */
function nextIndex(targets: Element[], lastShown: Element | null): number {
  if (!lastShown?.isConnected) return 0
  const index = targets.findIndex(
    (target) => lastShown.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
  return index === -1 ? 0 : index
}

/** An error, if the element shows any, or else a warning. */
function severityShownBy(element: Element, errors: ReportedError[]): ErrorSeverity {
  const ids = idsShownBy(element)
  return errors.some((e) => e.severity === "error" && ids.includes(e.componentId))
    ? "error"
    : "warning"
}

/** Outlines the element for a moment, so it stands out from the page it lands on. */
function flash(element: Element, severity: ErrorSeverity) {
  // Not in jsdom
  if (typeof element.animate !== "function") return
  const outline = `3px solid var(${severity === "error" ? "--color-destructive" : "--color-warning"})`
  element.animate(
    [
      { outline, outlineOffset: "3px" },
      { outline, outlineOffset: "3px", offset: 0.6 },
      { outline: "3px solid transparent", outlineOffset: "3px" },
    ],
    { duration: 1800, easing: "ease-out" },
  )
}
