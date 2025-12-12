/**
 * TelemetryContext provides anonymous usage tracking for Runbooks.
 * 
 * Telemetry is enabled by default but can be disabled via:
 *   - Environment variable: RUNBOOKS_TELEMETRY_DISABLE=1
 *   - CLI flag: --no-telemetry
 * 
 * We collect minimal, anonymous data to improve Runbooks:
 *   - Block types rendered (Command, Check, Template, Inputs)
 *   - Script execution success/failure counts (not content)
 *   - UI interactions
 * 
 * We do NOT collect:
 *   - Runbook content or file paths
 *   - Variable values or script contents
 *   - Personal identifiable information
 * 
 * Learn more: https://runbooks.gruntwork.io/security/telemetry/
 */

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import mixpanel from 'mixpanel-browser'
import { TelemetryContext, type TelemetryConfig } from './TelemetryContext.types'

// Mixpanel project token (public - only allows sending events, not reading)
// Set via VITE_MIXPANEL_TOKEN environment variable at build time
const MIXPANEL_TOKEN = import.meta.env.VITE_MIXPANEL_TOKEN || ''

interface TelemetryProviderProps {
  children: ReactNode
}

export function TelemetryProvider({ children }: TelemetryProviderProps) {
  const [config, setConfig] = useState<TelemetryConfig | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  
  // Guard against double initialization (React StrictMode calls effects twice in dev)
  const initStartedRef = useRef(false)

  // Fetch telemetry config from backend on mount
  useEffect(() => {
    // Prevent double initialization from StrictMode
    if (initStartedRef.current) {
      return
    }
    initStartedRef.current = true

    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/telemetry/config')
        if (response.ok) {
          const data: TelemetryConfig = await response.json()
          setConfig(data)

          // Initialize Mixpanel if telemetry is enabled and token is configured
          if (data.enabled && data.anonymousId && MIXPANEL_TOKEN) {
            mixpanel.init(MIXPANEL_TOKEN, {
              // Privacy-focused configuration
              ip: false, // Don't track IP addresses
              persistence: 'localStorage',
              track_pageview: false, // We'll track this manually
              debug: false,
            })

            // Identify with the anonymous ID from backend
            mixpanel.identify(data.anonymousId)

            // Set super properties that persist across all events
            mixpanel.register({
              version: data.version,
              platform: 'web',
            })

            setIsInitialized(true)

            // Track page view on initialization
            mixpanel.track('app_loaded')
          }
        }
      } catch (error) {
        // Silently ignore errors - telemetry should never impact user experience
        console.debug('[Telemetry] Failed to fetch config:', error)
      }
    }

    fetchConfig()
  }, [])

  // Generic track function
  const track = useCallback((event: string, properties?: Record<string, unknown>) => {
    if (!isInitialized || !config?.enabled) {
      return
    }

    try {
      mixpanel.track(event, properties)
    } catch (error) {
      // Silently ignore errors
      console.debug('[Telemetry] Track error:', error)
    }
  }, [isInitialized, config?.enabled])

  // Track block renders (Command, Check, Template, Inputs, etc.)
  const trackBlockRender = useCallback((blockType: string) => {
    track('block_rendered', { block_type: blockType })
  }, [track])

  // Track script executions (success/failure)
  const trackScriptExecution = useCallback((blockType: string, success: boolean) => {
    track('script_executed', {
      block_type: blockType,
      success,
    })
  }, [track])

  const contextValue = {
    isEnabled: config?.enabled ?? false,
    isInitialized,
    track,
    trackBlockRender,
    trackScriptExecution,
  }

  return (
    <TelemetryContext.Provider value={contextValue}>
      {children}
    </TelemetryContext.Provider>
  )
}
