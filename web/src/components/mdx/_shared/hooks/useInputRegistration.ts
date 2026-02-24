/**
 * Shared hook for input-collecting MDX blocks (Inputs, TfModule).
 *
 * These blocks follow the same lifecycle — register a unique ID, fetch or
 * receive a BoilerplateConfig, render a form, and submit the collected values
 * back to the runbook context. This hook extracts that common lifecycle so each
 * block only needs to supply its specific config and optional data transforms.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { AppError } from '@/types/error'
import type { BlockComponentType } from '@/contexts/ComponentIdRegistry'
import { useRunbookContext } from '@/contexts/useRunbook'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'

/**
 * Options accepted by {@link useInputRegistration}.
 */
interface UseInputRegistrationOptions {
  /** Unique component ID used for registration, error reporting, and form submission. */
  id: string
  /** Block type identifier (e.g. "Inputs", "TfModule") for telemetry and the ID registry. */
  componentType: BlockComponentType
  /** Parsed variable definitions that drive form state; null while still loading. */
  boilerplateConfig: BoilerplateConfig | null
  /** Error from prop/config validation (reported to the global error banner). */
  validationError: AppError | null
  /** Additional error to report (e.g., inline content parsing failures in Inputs). */
  extraError?: AppError | null
  /** Transform applied to raw form data before it is registered with the runbook context. */
  enrichFormData?: (formData: Record<string, unknown>) => Record<string, unknown>
}

interface UseInputRegistrationReturn {
  // Registry state
  isDuplicate: boolean
  isNormalizedCollision: boolean
  collidingId: string | undefined
  // Form state
  initialData: Record<string, unknown>
  hasSubmitted: boolean
  // Form handlers
  handleAutoUpdate: (formData: Record<string, unknown>) => void
  handleSubmit: (formData: Record<string, unknown>) => Promise<void>
}

/**
 * Shared hook for input-collecting components (Inputs, TfModule).
 *
 * Encapsulates the common lifecycle:
 * 1. Component ID registration and duplicate detection
 * 2. Error reporting to the global error banner
 * 3. Telemetry tracking
 * 4. Form state initialization from BoilerplateConfig
 * 5. Auto-update debouncing after first submit
 * 6. Form submission with optional data enrichment
 */
export function useInputRegistration({
  id,
  componentType,
  boilerplateConfig,
  validationError,
  extraError,
  enrichFormData,
}: UseInputRegistrationOptions): UseInputRegistrationReturn {
  // 1. ID registry
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, componentType)

  // 2. Error reporting
  const { reportError, clearError } = useErrorReporting()

  // 3. Telemetry
  const { trackBlockRender } = useTelemetry()
  useEffect(() => {
    trackBlockRender(componentType)
  }, [trackBlockRender, componentType])

  // 4. Form state
  const [formState, setFormState] = useState<BoilerplateConfig | null>(null)
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const { registerInputs } = useRunbookContext()

  const hasSetFormState = useRef(false)
  useEffect(() => {
    if (boilerplateConfig && !hasSetFormState.current) {
      setFormState(boilerplateConfig)
      hasSetFormState.current = true
    }
  }, [boilerplateConfig])

  const initialData = useMemo(() => {
    if (!formState) return {}
    return formState.variables.reduce((acc, variable) => {
      acc[variable.name] = variable.default
      return acc
    }, {} as Record<string, unknown>)
  }, [formState])

  // 5. Error effect — report config/setup issues to the global banner.
  // apiError is intentionally omitted here; it is rendered inline by the component (e.g., ErrorDisplay).
  useEffect(() => {
    if (isDuplicate) {
      reportError({ componentId: id, componentType, severity: 'error', message: `Duplicate component ID: ${id}` })
    } else if (validationError) {
      reportError({ componentId: id, componentType, severity: 'error', message: validationError.message })
    } else if (extraError) {
      reportError({ componentId: id, componentType, severity: 'error', message: extraError.message })
    } else {
      clearError(id)
    }
  }, [id, componentType, isDuplicate, validationError, extraError, reportError, clearError])

  // 6. Auto-update debouncing
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null)

  const handleAutoUpdate = useCallback((formData: Record<string, unknown>) => {
    if (!hasSubmitted) return

    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current)
    }

    autoUpdateTimerRef.current = setTimeout(() => {
      if (boilerplateConfig) {
        const data = enrichFormData ? enrichFormData(formData) : formData
        registerInputs(id, data, boilerplateConfig)
      }
    }, 200)
  }, [id, hasSubmitted, boilerplateConfig, registerInputs, enrichFormData])

  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current)
      }
    }
  }, [])

  // 7. Submit handler
  const handleSubmit = useCallback(async (formData: Record<string, unknown>) => {
    if (boilerplateConfig) {
      const data = enrichFormData ? enrichFormData(formData) : formData
      registerInputs(id, data, boilerplateConfig)
    }
    setHasSubmitted(true)
  }, [id, boilerplateConfig, registerInputs, enrichFormData])

  return {
    isDuplicate,
    isNormalizedCollision,
    collidingId,
    initialData,
    hasSubmitted,
    handleAutoUpdate,
    handleSubmit,
  }
}
