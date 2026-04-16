import type { ReactNode } from 'react'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { ComponentIdRegistryProvider } from '@/contexts/ComponentIdRegistry'
import { ErrorReportingProvider } from '@/contexts/ErrorReportingContext'
import { TelemetryContext, defaultContextValue } from '@/contexts/TelemetryContext.types'

/**
 * Wraps children in all required context providers for component tests.
 *
 * Telemetry is provided via the raw context with a disabled default so tests
 * don't trigger an IPC init path that isn't what's under test here.
 */
export function TestWrapper({ children, remoteSource }: { children: ReactNode; remoteSource?: string }) {
  return (
    <TelemetryContext.Provider value={defaultContextValue}>
      <ErrorReportingProvider>
        <ComponentIdRegistryProvider>
          <RunbookContextProvider runbookName="test" remoteSource={remoteSource}>
            {children}
          </RunbookContextProvider>
        </ComponentIdRegistryProvider>
      </ErrorReportingProvider>
    </TelemetryContext.Provider>
  )
}
