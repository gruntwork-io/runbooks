import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './css/index.css'
import App from './App.tsx'
import { ThemeProvider } from './contexts/ThemeContext'
import { ApiProvider } from './contexts/ApiContext'
import { GeneratedFilesProvider } from './contexts/GeneratedFilesContext'
import { IpcGitWorkTreeProvider } from './contexts/IpcGitWorkTreeContext'
import { IpcExecutableRegistryProvider } from './contexts/IpcExecutableRegistryContext'
import { ErrorReportingProvider } from './contexts/ErrorReportingContext'
import { IpcTelemetryProvider } from './contexts/IpcTelemetryContext'
import { LogsProvider } from './contexts/LogsContext'
import { IpcSessionProvider } from './contexts/IpcSessionContext'

const root = document.getElementById('root')!

if (!window.api) {
  // Opened in a regular browser instead of the Electron app window.
  createRoot(root).render(
    <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'system-ui' }}>
      <h1>Runbooks</h1>
      <p>This page must be opened inside the Runbooks desktop app.</p>
      <p style={{ color: '#666', marginTop: '1rem' }}>
        Run <code style={{ background: '#f0f0f0', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>just dev</code> to
        start the Electron app, then use the Electron window (not this browser tab).
      </p>
    </div>,
  )
} else {
  createRoot(root).render(
    <StrictMode>
      {/* ApiProvider bridges window.api (the preload bridge) into context so
          descendants can use useApi() instead of touching window directly. */}
      <ApiProvider api={window.api}>
        <ThemeProvider>
          <IpcTelemetryProvider>
            <IpcSessionProvider>
              <ErrorReportingProvider>
                <IpcExecutableRegistryProvider>
                  <GeneratedFilesProvider>
                    <IpcGitWorkTreeProvider>
                      <LogsProvider>
                        <App />
                      </LogsProvider>
                    </IpcGitWorkTreeProvider>
                  </GeneratedFilesProvider>
                </IpcExecutableRegistryProvider>
              </ErrorReportingProvider>
            </IpcSessionProvider>
          </IpcTelemetryProvider>
        </ThemeProvider>
      </ApiProvider>
    </StrictMode>,
  )
}
