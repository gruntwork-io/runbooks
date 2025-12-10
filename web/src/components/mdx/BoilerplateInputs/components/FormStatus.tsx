import React, { useState, useEffect, useRef } from 'react'
import { CircleCheck, Loader2, CircleX } from 'lucide-react'

type FormStatusState = 'valid' | 'updating' | 'error'

interface FormStatusProps {
  /** Whether the form is currently valid */
  isValid: boolean
  /** Whether auto-rendering is in progress */
  isUpdating: boolean
  /** Whether this is for inline mode (variables) vs file generation mode */
  isInlineMode?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * FormStatus component that shows the current state of the form after initial generation.
 * 
 * Displays one of three states:
 * - Valid: Green checkmark with "Fields will update automatically" message
 * - Updating: Spinner with "Updating..." message (shown briefly during auto-render)
 * - Error: Red X with "Fix validation errors above" message
 * 
 * The updating state lingers for a minimum duration to provide visual feedback
 * even when updates are nearly instantaneous.
 * 
 * @param props - Component props
 * @param props.isValid - Whether the form currently passes validation
 * @param props.isUpdating - Whether an auto-render is in progress
 * @param props.isInlineMode - Whether using inline mode (updates variables) vs file generation
 * @param props.className - Additional CSS classes
 */
export const FormStatus: React.FC<FormStatusProps> = ({
  isValid,
  isUpdating,
  isInlineMode = false,
  className = ''
}) => {
  // Track the visual state with minimum display duration for updating
  const [displayState, setDisplayState] = useState<FormStatusState>('valid')
  const updateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateStartTimeRef = useRef<number>(0)
  
  // Minimum time to show the updating state (in ms) for visual feedback
  const MIN_UPDATE_DURATION = 400

  useEffect(() => {
    // Clean up any existing timeout
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current)
      updateTimeoutRef.current = null
    }

    if (!isValid) {
      // Error state takes precedence
      setDisplayState('error')
    } else if (isUpdating) {
      // Start showing updating state
      updateStartTimeRef.current = Date.now()
      setDisplayState('updating')
    } else if (displayState === 'updating') {
      // Transitioning from updating to valid - ensure minimum duration
      const elapsed = Date.now() - updateStartTimeRef.current
      const remaining = Math.max(0, MIN_UPDATE_DURATION - elapsed)
      
      if (remaining > 0) {
        updateTimeoutRef.current = setTimeout(() => {
          setDisplayState('valid')
        }, remaining)
      } else {
        setDisplayState('valid')
      }
    } else {
      // Just valid
      setDisplayState('valid')
    }

    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }
    }
  }, [isValid, isUpdating, displayState])

  const autoUpdateMessage = isInlineMode 
    ? 'Variable values will update automatically as you type.'
    : 'Generated files will update automatically as you type.'

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        {displayState === 'error' && (
          <>
            <CircleX className="size-5 text-red-500 flex-shrink-0" />
            <span className="text-sm text-red-600 font-medium">
              Fix validation errors above
            </span>
          </>
        )}
        
        {displayState === 'updating' && (
          <>
            <Loader2 className="size-5 text-blue-500 flex-shrink-0 animate-spin" />
            <span className="text-sm text-blue-600 font-medium">
              Updating...
            </span>
          </>
        )}
        
        {displayState === 'valid' && (
          <>
            <CircleCheck className="size-5 text-green-600 flex-shrink-0" />
            <span className="text-sm text-green-700 font-medium">
              Up to date
            </span>
          </>
        )}
      </div>
      
      {/* Help text shown when valid or updating */}
      {displayState !== 'error' && (
        <p className="text-sm text-gray-400 italic">
          {autoUpdateMessage}
        </p>
      )}
    </div>
  )
}

