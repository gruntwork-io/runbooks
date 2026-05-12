import { useState, useEffect, useCallback, useRef } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'
import { markStage } from '@/lib/renderPerf'

/**
 * Debounce delay for auto-render in milliseconds.
 *
 * Below typical adult typing cadence (~200 ms/char) so sustained typing
 * fires roughly one render per character. The dispatcher+WASM warm path
 * absorbs this comfortably: dirty-set rendering keeps each render at
 * ~85 ms wall time, and fiber-interrupt supersession (see
 * electron/main/ipc/boilerplate.ts activeRenders) reclaims any in-flight
 * work the user superseded. CPU waste per superseded render is small
 * because the WASM call hasn't typically completed when a new keystroke
 * arrives at this cadence.
 *
 * 50 ms is the lower bound where the user perceives a "responsive
 * preview" without the floor becoming a perceptible delay. Going lower
 * starts firing renders on intermediate keystrokes that haven't actually
 * settled (paste handlers, dead keys, etc.) without UX benefit.
 */
const AUTO_RENDER_DEBOUNCE_MS = 50

/**
 * Custom hook for managing form state and data flow
 * 
 * @param boilerplateConfig - The boilerplate configuration containing variable definitions
 * @param initialData - Initial form data values (only used on first mount)
 * @param onFormChange - Optional callback when form data changes
 * @param onAutoRender - Optional callback to trigger re-rendering when form data changes (debounced)
 * @param enableAutoRender - Whether auto-rendering should be enabled (default: true)
 * @returns Object containing form state and update methods
 */
export const useFormState = (
  boilerplateConfig: BoilerplateConfig | null,
  initialData: Record<string, unknown> = {},
  onFormChange?: (formData: Record<string, unknown>) => void,
  onAutoRender?: (formData: Record<string, unknown>) => void,
  enableAutoRender: boolean = true
) => {
  const [formData, setFormData] = useState<Record<string, unknown>>({})

  // Store latest callback references to avoid stale closures
  const onFormChangeRef = useRef(onFormChange)
  const onAutoRenderRef = useRef(onAutoRender)
  
  // Track if we've done initial setup
  const hasInitialized = useRef(false)
  
  // Store initialData at mount time (for initial setup only)
  const initialDataRef = useRef(initialData)
  
  // Ref for debounce timer + leading-edge bookkeeping.
  // `autoRenderTimerRef` tracks a pending trailing-edge fire.
  // `lastFireAtRef` is the wall-clock time of the most recent fire (leading
  //   or trailing); when more than AUTO_RENDER_DEBOUNCE_MS has elapsed since
  //   that time, the next change fires immediately (leading edge).
  const autoRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFireAtRef = useRef<number>(0)

  // Update refs when callbacks change
  useEffect(() => {
    onFormChangeRef.current = onFormChange
  }, [onFormChange])

  useEffect(() => {
    onAutoRenderRef.current = onAutoRender
  }, [onAutoRender])
  
  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (autoRenderTimerRef.current) {
        clearTimeout(autoRenderTimerRef.current)
      }
    }
  }, [])

  // Initialize form data ONCE with defaults and initial values
  // This only runs when boilerplateConfig first becomes available
  useEffect(() => {
    if (!boilerplateConfig || hasInitialized.current) return
    
    const formDataInit: Record<string, unknown> = {}
    
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      formDataInit[variable.name] = initialDataRef.current[variable.name] ?? variable.default
    })
    
    setFormData(formDataInit)
    hasInitialized.current = true
  }, [boilerplateConfig])

  // Notify parent component when form data changes
  useEffect(() => {
    if (onFormChangeRef.current) {
      onFormChangeRef.current(formData)
    }
  }, [formData])

  // Track if this is the initial load for auto-render purposes
  const [isInitialLoad, setIsInitialLoad] = useState(true)

  // Trigger auto-rendering when form data changes (debounced, not on initial load)
  useEffect(() => {
    // Mark that initial load is complete after first form data is set
    if (Object.keys(formData).length > 0 && isInitialLoad) {
      setIsInitialLoad(false)
      return // Don't trigger auto-render on initial load
    }
    
    // Only trigger auto-render if auto-rendering is enabled, we have form data, and it's not the initial load
    if (enableAutoRender && onAutoRenderRef.current && Object.keys(formData).length > 0 && !isInitialLoad) {
      // Leading + trailing debounce:
      //
      //   - When the user has been idle for at least AUTO_RENDER_DEBOUNCE_MS,
      //     fire IMMEDIATELY on the next keystroke. This is the leading edge.
      //     The whole point of the debounce is to coalesce rapid edits within
      //     a burst; the *first* keystroke of a burst doesn't need to wait
      //     for the burst to settle to get feedback to the user.
      //
      //   - During an active burst (within the debounce window of the last
      //     fire), schedule a trailing-edge fire that reflects the final
      //     state. Any new keystroke before the trailing fires resets the
      //     timer.
      //
      // Net behavior: typing "abc" with 50 ms between strokes →
      //   "a" fires immediately (leading), "c" fires after a 50 ms quiet
      //   period (trailing); "b" is collapsed.
      const now = Date.now()
      const sinceLastFire = now - lastFireAtRef.current
      const fire = () => {
        lastFireAtRef.current = Date.now()
        markStage('useFormState:debounce-fire')
        if (onAutoRenderRef.current) {
          onAutoRenderRef.current(formData)
        }
      }

      if (autoRenderTimerRef.current) {
        clearTimeout(autoRenderTimerRef.current)
        autoRenderTimerRef.current = null
      }

      if (sinceLastFire >= AUTO_RENDER_DEBOUNCE_MS) {
        // Leading edge: idle long enough, fire now.
        fire()
        // Still schedule a trailing fire to capture any final keystroke that
        // arrives during this debounce window — without it, a single fast
        // keystroke after the leading would never re-fire.
        autoRenderTimerRef.current = setTimeout(() => {
          autoRenderTimerRef.current = null
          fire()
        }, AUTO_RENDER_DEBOUNCE_MS)
      } else {
        // Inside the debounce window: trailing fire only.
        autoRenderTimerRef.current = setTimeout(() => {
          autoRenderTimerRef.current = null
          fire()
        }, AUTO_RENDER_DEBOUNCE_MS - sinceLastFire)
      }
    }
  }, [formData, isInitialLoad, enableAutoRender])

  /**
   * Updates a specific form field value
   * @param fieldName - Name of the field to update
   * @param value - New value for the field
   */
  const updateField = useCallback((fieldName: string, value: unknown) => {
    setFormData(prev => ({
      ...prev,
      [fieldName]: value
    }))
  }, [])

  /**
   * Updates multiple form fields at once
   * @param updates - Object with field names as keys and new values
   */
  const updateFields = useCallback((updates: Record<string, unknown>) => {
    setFormData(prev => ({
      ...prev,
      ...updates
    }))
  }, [])

  /**
   * Resets the form to default values from the boilerplate configuration
   */
  const resetForm = useCallback(() => {
    if (!boilerplateConfig) return
    
    const resetData: Record<string, unknown> = {}
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      resetData[variable.name] = variable.default
    })
    
    setFormData(resetData)
  }, [boilerplateConfig])

  return {
    formData,
    updateField,
    updateFields,
    resetForm
  }
}
