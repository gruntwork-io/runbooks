import { createContext } from 'react'

// Context value type
export interface TelemetryContextValue {
  isEnabled: boolean
  isInitialized: boolean
  track: (event: string, properties?: Record<string, unknown>) => void
  trackBlockRender: (blockType: string) => void
  trackScriptExecution: (blockType: string, success: boolean) => void
}

// Default context value when not initialized
export const defaultContextValue: TelemetryContextValue = {
  isEnabled: false,
  isInitialized: false,
  track: () => {},
  trackBlockRender: () => {},
  trackScriptExecution: () => {},
}

// Telemetry configuration from backend
export interface TelemetryConfig {
  enabled: boolean
  anonymousId: string
  version: string
}

export const TelemetryContext = createContext<TelemetryContextValue>(defaultContextValue)

