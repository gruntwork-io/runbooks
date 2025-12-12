import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './css/index.css'
import App from './App.tsx'
import { FileTreeProvider } from './contexts/FileTreeContext'
import { ExecutableRegistryProvider } from './contexts/ExecutableRegistryContext'
import { ErrorReportingProvider } from './contexts/ErrorReportingContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorReportingProvider>
      <ExecutableRegistryProvider>
        <FileTreeProvider>
          <App />
        </FileTreeProvider>
      </ExecutableRegistryProvider>
    </ErrorReportingProvider>
  </StrictMode>,
)
