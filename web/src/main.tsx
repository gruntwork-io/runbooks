import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './css/index.css'
import App from './App.tsx'
import { FileTreeProvider } from './contexts/FileTreeContext'
import { ExecutableRegistryProvider } from './contexts/ExecutableRegistryContext'
import { ErrorReportingProvider } from './contexts/ErrorReportingContext'
import { TelemetryProvider } from './contexts/TelemetryContext'
import { LogsProvider } from './contexts/LogsContext'
import { SessionProvider } from './contexts/SessionContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TelemetryProvider>
      <SessionProvider>
        <ErrorReportingProvider>
          <ExecutableRegistryProvider>
            <FileTreeProvider>
              <LogsProvider>
                <App />
              </LogsProvider>
            </FileTreeProvider>
          </ExecutableRegistryProvider>
        </ErrorReportingProvider>
      </SessionProvider>
    </TelemetryProvider>
  </StrictMode>,
)
