import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './css/index.css'
import App from './App.tsx'
import { TelemetryProvider } from './contexts/TelemetryContext'

// TelemetryProvider stays at the app root because the Welcome screen
// benefits from it too (so future "recent gruntbook opened" events are
// captured regardless of which view the user is in). Every other
// provider is scoped to RunbookView, since they only exist to support
// the runbook experience itself.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TelemetryProvider>
      <App />
    </TelemetryProvider>
  </StrictMode>,
)
