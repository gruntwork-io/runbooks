import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { AppError } from '@/types/error'
import type { BlockComponentType } from '@/contexts/ComponentIdRegistry'
import { useRunbookContext } from '@/contexts/useRunbook'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'

interface UseInputRegistrationOptions {
  id: string
  componentType: BlockComponentType
  boilerplateConfig: BoilerplateConfig | null
  validationError: AppError | null
  apiError: AppError | null
  /** Additional errors to report (e.g., inline content errors in Inputs) */
  extraError?: AppError | null
  /** Optional transform applied to formData before calling registerInputs */
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
  apiError,
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

  // 5. Error effect — report the first applicable error or clear
  useEffect(() => {
    if (isDuplicate) {
      reportError({ componentId: id, componentType, severity: 'error', message: `Duplicate component ID: ${id}` })
    } else if (validationError) {
      reportError({ componentId: id, componentType, severity: 'error', message: validationError.message })
    } else if (extraError) {
      reportError({ componentId: id, componentType, severity: 'error', message: extraError.message })
    } else if (apiError) {
      reportError({ componentId: id, componentType, severity: 'error', message: apiError.message })
    } else {
      clearError(id)
    }
  }, [id, componentType, isDuplicate, validationError, extraError, apiError, reportError, clearError])

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
