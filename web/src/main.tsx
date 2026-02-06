import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './css/index.css'
import App from './App.tsx'
import { GeneratedFilesProvider } from './contexts/GeneratedFilesContext'
import { GitWorkTreeProvider } from './contexts/GitWorkTreeContext'
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
            <GeneratedFilesProvider>
              <GitWorkTreeProvider>
                <LogsProvider>
                  <App />
                </LogsProvider>
              </GitWorkTreeProvider>
            </GeneratedFilesProvider>
          </ExecutableRegistryProvider>
        </ErrorReportingProvider>
      </SessionProvider>
    </TelemetryProvider>
  </StrictMode>,
)
