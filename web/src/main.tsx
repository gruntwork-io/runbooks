import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './css/index.css'
import App from './App.tsx'
import { FileTreeProvider } from './contexts/FileTreeContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FileTreeProvider>
      <App />
    </FileTreeProvider>
  </StrictMode>,
)
