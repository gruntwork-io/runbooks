import { useContext } from 'react'
import { TelemetryContext } from './TelemetryContext.types'

/**
 * Hook for accessing telemetry functions.
 * Use this to track events from components.
 */
export function useTelemetry() {
  return useContext(TelemetryContext)
}
