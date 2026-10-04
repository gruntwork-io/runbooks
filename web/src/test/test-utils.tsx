import { useMemo, type ReactNode } from "react"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { InstructionModeProvider } from "@/contexts/InstructionModeContext"
import {
  RunbookContext,
  RunbookContextProvider,
  type RunbookContextType,
} from "@/contexts/RunbookContext"
import { ComponentIdRegistryProvider } from "@/contexts/ComponentIdRegistry"
import { ErrorReportingProvider } from "@/contexts/ErrorReportingContext"
import { TelemetryContext, defaultContextValue } from "@/contexts/TelemetryContext.types"

/**
 * Wraps children in all required context providers for component tests.
 *
 * Telemetry is provided via the raw context with a disabled default so tests
 * don't trigger an IPC init path that isn't what's under test here.
 */
export function TestWrapper({
  children,
  remoteSource,
  assetHost,
}: {
  children: ReactNode
  remoteSource?: string
  assetHost?: string
}) {
  return (
    <ThemeProvider>
      <InstructionModeProvider>
        <TelemetryContext.Provider value={defaultContextValue}>
          <ErrorReportingProvider>
            <ComponentIdRegistryProvider>
              <RunbookContextProvider
                runbookName="test"
                remoteSource={remoteSource}
                assetHost={assetHost}
              >
                {children}
              </RunbookContextProvider>
            </ComponentIdRegistryProvider>
          </ErrorReportingProvider>
        </TelemetryContext.Provider>
      </InstructionModeProvider>
    </ThemeProvider>
  )
}

/**
 * Provides a RunbookContext holding only the given block inputs and outputs,
 * for a test of a component that reads them but registers nothing.
 */
export function RunbookStateStub({
  blockInputs = EMPTY_BLOCK_STATE,
  blockOutputs = EMPTY_BLOCK_STATE,
  children,
}: {
  blockInputs?: RunbookContextType["blockInputs"]
  blockOutputs?: RunbookContextType["blockOutputs"]
  children: ReactNode
}) {
  const value = useMemo(
    () => ({ blockInputs, blockOutputs }) as RunbookContextType,
    [blockInputs, blockOutputs],
  )
  return <RunbookContext.Provider value={value}>{children}</RunbookContext.Provider>
}

const EMPTY_BLOCK_STATE = {}
