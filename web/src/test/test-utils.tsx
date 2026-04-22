import type { ReactNode } from 'react'
import { GruntbookContextProvider } from '@/contexts/GruntbookContext'
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
          <GruntbookContextProvider gruntbookName="test" remoteSource={remoteSource}>
            {children}
          </GruntbookContextProvider>
        </ComponentIdRegistryProvider>
      </ErrorReportingProvider>
    </TelemetryProvider>
  )
}
