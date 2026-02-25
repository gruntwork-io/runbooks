import type { ReactNode } from 'react'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { ComponentIdRegistryProvider } from '@/contexts/ComponentIdRegistry'
import { ErrorReportingProvider } from '@/contexts/ErrorReportingContext'
import { TelemetryProvider } from '@/contexts/TelemetryContext'

/**
 * Wraps children in all required context providers for component tests.
 */
export function TestWrapper({ children, remoteSource }: { children: ReactNode; remoteSource?: string }) {
  return (
    <TelemetryProvider>
      <ErrorReportingProvider>
        <ComponentIdRegistryProvider>
          <RunbookContextProvider runbookName="test" remoteSource={remoteSource}>
            {children}
          </RunbookContextProvider>
        </ComponentIdRegistryProvider>
      </ErrorReportingProvider>
    </TelemetryProvider>
  )
}
