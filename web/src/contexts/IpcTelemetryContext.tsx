/**
 * IPC version of TelemetryContext — fetches config via Electron IPC instead of HTTP.
 *
 * Telemetry is enabled by default but can be disabled via:
 *   - Environment variable: RUNBOOKS_TELEMETRY_DISABLE=1
 *   - CLI flag: --no-telemetry
 *
 * We collect minimal, anonymous data to improve Runbooks:
 *   - Commands used (open, watch, serve)
 *   - Block types in runbooks (Command, Check, Template, Inputs)
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
import { useApi } from './ApiContext'

// Mixpanel project token (public - only allows sending events, not reading)
// Set via VITE_MIXPANEL_TOKEN environment variable at build time
const MIXPANEL_TOKEN = import.meta.env.VITE_MIXPANEL_TOKEN || ''

interface IpcTelemetryProviderProps {
  children: ReactNode
}

export function IpcTelemetryProvider({ children }: IpcTelemetryProviderProps) {
  const [config, setConfig] = useState<TelemetryConfig | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const api = useApi()

  // Guard against double initialization (React StrictMode calls effects twice in dev)
  const initStartedRef = useRef(false)

  // Block render aggregation - collect blocks and send a single event
  const blockCountsRef = useRef<Record<string, number>>({})
  const blockAggregateTimerRef = useRef<number | null>(null)
  const hasSentRunbookLoadedRef = useRef(false)

  // Fetch telemetry config from backend via IPC on mount
  useEffect(() => {
    if (initStartedRef.current) {
      return
    }
    initStartedRef.current = true

    const fetchConfig = async () => {
      try {
        const data = await api.invoke<TelemetryConfig>('telemetry:config')
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
            platform: 'electron',
          })

          setIsInitialized(true)

          // Track page view on initialization
          mixpanel.track('app_loaded')
        }
      } catch (error) {
        // Silently ignore errors - telemetry should never impact user experience
        console.debug('[Telemetry] Failed to fetch config via IPC:', error)
      }
    }

    fetchConfig()
  }, [api])

  // Cleanup aggregation timer on unmount
  useEffect(() => {
    return () => {
      if (blockAggregateTimerRef.current) {
        clearTimeout(blockAggregateTimerRef.current)
      }
    }
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

  // Store track in a ref so trackBlockRender can access the latest version
  // without needing it in its dependency array (keeps stable identity)
  const trackRef = useRef(track)
  trackRef.current = track

  // Track block renders by aggregating them into a single 'runbook_loaded' event
  const trackBlockRender = useCallback((blockType: string) => {
    // Increment the count for this block type
    blockCountsRef.current[blockType] = (blockCountsRef.current[blockType] || 0) + 1

    // Clear existing timer
    if (blockAggregateTimerRef.current) {
      clearTimeout(blockAggregateTimerRef.current)
    }

    // Set a new timer - after 500ms of no new blocks, send the aggregated event
    blockAggregateTimerRef.current = window.setTimeout(() => {
      // Only send once per page load
      if (hasSentRunbookLoadedRef.current) {
        return
      }
      hasSentRunbookLoadedRef.current = true

      // Send a single event with block counts
      const counts = blockCountsRef.current
      trackRef.current('runbook_loaded', {
        block_counts: counts,
        total_blocks: Object.values(counts).reduce((sum, count) => sum + count, 0),
      })
    }, 500)
  }, []) // Empty deps for stable identity - uses trackRef for latest track function

  const contextValue = {
    isEnabled: config?.enabled ?? false,
    isInitialized,
    track,
    trackBlockRender,
  }

  return (
    <TelemetryContext.Provider value={contextValue}>
      {children}
    </TelemetryContext.Provider>
  )
}
