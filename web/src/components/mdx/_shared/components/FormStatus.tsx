import React, { useState, useEffect, useRef } from "react"
import { CircleCheck, Loader2, CircleX } from "lucide-react"

type FormStatusState = "valid" | "updating" | "error" | "failed"

interface FormStatusProps {
  /** Whether the form is currently valid */
  isValid: boolean
  /** Whether auto-rendering is in progress */
  isUpdating: boolean
  /** Whether this is for inline mode (variables) vs file generation mode */
  isInlineMode?: boolean
  /** Whether the latest render failed (the parent displays the error itself) */
  hasRenderError?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * FormStatus component that shows the current state of the form after initial generation.
 *
 * Displays one of four states:
 * - Valid: Green checkmark with "Fields will update automatically" message
 * - Updating: Spinner with "Updating..." message (shown briefly during auto-render)
 * - Error: Red X with "Fix validation errors above" message
 * - Failed: Red X with "Generation failed" message (the latest render failed)
 *
 * The updating state lingers for a minimum duration to provide visual feedback
 * even when updates are nearly instantaneous.
 *
 * @param props - Component props
 * @param props.isValid - Whether the form currently passes validation
 * @param props.isUpdating - Whether an auto-render is in progress
 * @param props.isInlineMode - Whether using inline mode (updates variables) vs file generation
 * @param props.hasRenderError - Whether the latest render failed
 * @param props.className - Additional CSS classes
 */
export const FormStatus: React.FC<FormStatusProps> = ({
  isValid,
  isUpdating,
  isInlineMode = false,
  hasRenderError = false,
  className = "",
}) => {
  // True while the updating state is held past the end of an update to reach
  // its minimum display duration.
  const [lingering, setLingering] = useState(false)
  const updateStartTimeRef = useRef<number>(0)

  // Minimum time to show the updating state (in ms) for visual feedback
  const MIN_UPDATE_DURATION = 400

  const [prevIsUpdating, setPrevIsUpdating] = useState(isUpdating)
  if (isUpdating !== prevIsUpdating) {
    setPrevIsUpdating(isUpdating)
    if (!isUpdating && isValid) {
      setLingering(true)
    }
  }
  // Error state takes precedence and ends any linger.
  if (!isValid && lingering) {
    setLingering(false)
  }

  let displayState: FormStatusState
  if (!isValid) {
    displayState = "error"
  } else if (isUpdating || lingering) {
    displayState = "updating"
  } else {
    displayState = hasRenderError ? "failed" : "valid"
  }

  useEffect(() => {
    if (isUpdating) {
      updateStartTimeRef.current = Date.now()
      return
    }
    if (!lingering) return

    const elapsed = Date.now() - updateStartTimeRef.current
    const remaining = Math.max(0, MIN_UPDATE_DURATION - elapsed)
    const timeout = setTimeout(() => setLingering(false), remaining)
    return () => clearTimeout(timeout)
  }, [isUpdating, lingering])

  const autoUpdateMessage = isInlineMode
    ? "Variable values will update automatically as you type."
    : "Generated files will update automatically as you type."

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        {displayState === "error" && (
          <>
            <CircleX className="size-5 text-destructive flex-shrink-0" />
            <span className="text-sm text-destructive font-medium">
              Fix validation errors above
            </span>
          </>
        )}

        {displayState === "updating" && (
          <>
            <Loader2 className="size-5 text-primary flex-shrink-0 animate-spin" />
            <span className="text-sm text-primary font-medium">Updating...</span>
          </>
        )}

        {displayState === "failed" && (
          <>
            <CircleX className="size-5 text-destructive flex-shrink-0" />
            <span className="text-sm text-destructive font-medium">
              Generation failed. See the error above.
            </span>
          </>
        )}

        {displayState === "valid" && (
          <>
            <CircleCheck className="size-5 text-success flex-shrink-0" />
            <span className="text-sm text-success font-medium">Up to date</span>
          </>
        )}
      </div>

      {/* Help text shown when valid or updating */}
      {displayState !== "error" && (
        <p className="text-sm text-muted-foreground italic">{autoUpdateMessage}</p>
      )}
    </div>
  )
}
