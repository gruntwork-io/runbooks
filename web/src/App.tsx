import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import { useState, useEffect } from 'react'
import { BookOpen, Code, AlertTriangle } from "lucide-react"
import { Header } from './components/Header'
import MDXContainer from './components/MDXContainer'
import { ArtifactsContainer } from './components/ArtifactsContainer'
import { ViewContainerToggle } from './components/ViewContainerToggle'
import { getDirectoryPath, hasGeneratedFiles } from './lib/utils'
import { useGetRunbook } from './hooks/useApiGetRunbook'
import { useFileTree } from './hooks/useFileTree'
import type { AppError } from './types/error'


function App() {
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'code'>('markdown')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<AppError | null>(null);
  const [isArtifactsHidden, setIsArtifactsHidden] = useState(true);
  const [showCodeButton, setShowCodeButton] = useState(false);
  
  // Use the useApi hook to fetch runbook data
  const getRunbookResult = useGetRunbook()
  
  // Get file tree state to detect when files are generated
  const { fileTree } = useFileTree()
  const hasFiles = hasGeneratedFiles(fileTree)
  
  // Show artifacts panel unless user has manually hidden it
  const showArtifacts = !isArtifactsHidden
  
  // Auto-show artifacts panel and switch mobile view when files are generated/regenerated
  useEffect(() => {
    if (hasFiles) {
      setIsArtifactsHidden(false)
      // Also auto-switch mobile to code view
      if (activeMobileSection === 'markdown') {
        setActiveMobileSection('code')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTree, hasFiles]) // Don't include activeMobileSection to avoid blocking user's manual toggle
  
  // Delay showing the "show code" button to avoid awkward appearance during closing animation
  useEffect(() => {
    if (!showArtifacts) {
      const timer = setTimeout(() => {
        setShowCodeButton(true)
      }, 500) // 1.5 second delay
      return () => clearTimeout(timer)
    } else {
      setShowCodeButton(false)
    }
  }, [showArtifacts])
  
  // Update local state when hook state changes
  useEffect(() => {
    setIsLoading(getRunbookResult.isLoading)
    setError(getRunbookResult.error)
  }, [getRunbookResult.isLoading, getRunbookResult.error])
  
  // Extract commonly used values
  const pathName = getRunbookResult.data?.path || ''
  const content = getRunbookResult.data?.content || ''
  const runbookPath = getDirectoryPath(pathName)

  // Check if there is an error
  function hasError() {
    return Boolean(error?.message || error?.details);
  }

  return (
    <>
      <div className="flex flex-col">
        <Header pathName={pathName} />
        
        {/* Loading and Error States */}
        {isLoading ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading runbook...</p>
            </div>
          </div>
        ) : hasError() ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-md mx-auto p-6">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-lg font-medium text-red-800 mb-2">Failed to Load Runbook</h3>
                <p className="text-red-700 mb-2">{error?.message}</p>
                <p className="text-sm text-red-600 mb-4">
                  {error?.details}
                </p>
                <button 
                  onClick={() => window.location.reload()} 
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop Layout - Side by side */}
            <div className="hidden lg:block lg:m-6 lg:mt-0 translate translate-y-19 lg:mb-20">
              <div className="flex gap-8 h-[calc(100vh-5rem)] overflow-hidden justify-center">
                {/* Markdown/MDX content - takes full width when no files, normal size when files appear */}
                <div className={`relative ${showArtifacts ? 'flex-1 max-w-3xl min-w-xl' : 'w-full max-w-4xl'}`}>
                  <MDXContainer 
                    content={content}
                    runbookPath={runbookPath}
                    className="p-8 h-full"
                  />
                  
                  {/* Show code icon button when artifacts panel is not showing (with delay) */}
                  {showCodeButton && (
                    <button
                      onClick={() => setIsArtifactsHidden(false)}
                      className="absolute -right-14 top-0 p-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 z-10 cursor-pointer"
                      title="Show generated files"
                    >
                      <Code className="w-5 h-5 text-gray-600" />
                    </button>
                  )}
                </div>

                {/* Artifacts - grows/shrinks width smoothly */}
                <div 
                  className={`relative max-w-4xl transition-all duration-700 ease-in-out overflow-hidden ${
                    showArtifacts ? 'flex-2' : 'w-0'
                  }`}
                >
                  <ArtifactsContainer 
                    className="absolute top-0 left-0 right-0 h-screen" 
                    onHide={() => setIsArtifactsHidden(true)}
                    hideContent={!showArtifacts}
                  />
                </div>
              </div>
            </div>

            {/* Mobile Layout - Tabbed interface */}
            <div className="lg:hidden w-full pt-20">
              {/* Mobile Navigation */}
              <div className="flex items-center justify-center mb-6 fixed top-18 left-1/2 -translate-x-1/2 transition-all duration-300 ease-in-out">
                <div className="bg-gray-100 border border-gray-200 inline-flex h-12 w-fit items-center justify-center rounded-full p-1">
                  <ViewContainerToggle
                    activeView={activeMobileSection}
                    onViewChange={(view) => setActiveMobileSection(view as 'markdown' | 'code')}
                    views={[
                      { label: 'Markdown', value: 'markdown', icon: BookOpen },
                      { label: 'Code', value: 'code', icon: Code }
                    ]}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Mobile Content */}
              <div className="relative w-full px-4 mt-15">
                {/* Markdown/MDX Section */}
                <div className={activeMobileSection === 'markdown' ? 'block' : 'hidden'}>
                  <MDXContainer 
                    content={content}
                    runbookPath={runbookPath}
                    className="p-6 w-full max-h-[calc(100vh-9.5rem)]"
                  />
                </div>

                {/* Artifacts Section */}
                <div className={activeMobileSection === 'code' ? 'block' : 'hidden'}>
                  <div className="w-full h-[calc(100vh-12rem)] border border-gray-200 rounded-lg shadow-md overflow-hidden">
                    <ArtifactsContainer className="w-full h-full" onHide={() => setIsArtifactsHidden(true)} />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

export default App