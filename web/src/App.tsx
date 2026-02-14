import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import { useState, useEffect, useCallback } from 'react'
import { BookOpen, Code, AlertTriangle } from "lucide-react"
import { Header } from './components/layout/Header'
import { ErrorSummaryBanner } from './components/layout/ErrorSummaryBanner'
import MDXContainer from './components/MDXContainer'
import { ArtifactsContainer } from './components/layout/ArtifactsContainer'
import { ViewContainerToggle } from './components/layout/ViewContainerToggle'
import { GeneratedFilesAlert, shouldShowGeneratedFilesAlert } from './components/layout/GeneratedFilesAlert'
import { getDirectoryPath, hasGeneratedFiles } from './lib/utils'
import { useGetRunbook } from './hooks/useApiGetRunbook'
import { useFileTree } from './hooks/useFileTree'
import { useGitWorkTree } from './contexts/useGitWorkTree'
import { useWatchMode } from './hooks/useWatchMode'
import { useApiGeneratedFilesCheck } from './hooks/useApiGeneratedFilesCheck'
import { useErrorReporting } from './contexts/useErrorReporting'
import { cn } from './lib/utils'

function App() {
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'code'>('markdown')
  const [isArtifactsHidden, setIsArtifactsHidden] = useState(true);
  const [showCodeButton, setShowCodeButton] = useState(false);
  const [showGeneratedFilesAlert, setShowGeneratedFilesAlert] = useState(false);
  const [alertDismissedThisSession, setAlertDismissedThisSession] = useState(false);
  
  // Use the useApi hook to fetch runbook data
  const getRunbookResult = useGetRunbook()
  
  // Check for existing generated files when runbook loads
  const generatedFilesCheck = useApiGeneratedFilesCheck()
  
  // Get error counts from the error reporting context (populated by MDX components)
  const { errorCount, warningCount, clearAllErrors } = useErrorReporting()
  
  // Clear errors when runbook content changes (to avoid stale errors)
  useEffect(() => {
    if (getRunbookResult.data?.content) {
      clearAllErrors()
    }
  }, [getRunbookResult.data?.content, clearAllErrors])
  
  // Enable watch mode - refetch runbook when file changes
  const handleFileChange = useCallback(() => {
    console.log('[App] Runbook file changed, reloading...');
    
    // Use silent refetch for watch mode, regular refetch for open mode
    if (getRunbookResult.data?.isWatchMode) {
      getRunbookResult.silentRefetch();
    } else {
      getRunbookResult.refetch();
    }
  }, [getRunbookResult]);
  
  useWatchMode(handleFileChange, getRunbookResult.data?.isWatchMode ?? false);
  
  // Get file tree state to detect when files are generated
  const { fileTree } = useFileTree()
  const hasFiles = hasGeneratedFiles(fileTree)
  
  // Get git worktree state to detect when a repo is cloned
  const { workTrees } = useGitWorkTree()
  const hasWorkTrees = workTrees.length > 0
  
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
  
  // Auto-show artifacts panel when a git worktree is registered (repo cloned)
  useEffect(() => {
    if (hasWorkTrees) {
      setIsArtifactsHidden(false)
      if (activeMobileSection === 'markdown') {
        setActiveMobileSection('code')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWorkTrees]) // Don't include activeMobileSection to avoid blocking user's manual toggle
  
  // Delay showing the "show code" button to avoid awkward appearance during closing animation
  useEffect(() => {
    if (!showArtifacts) {
      const timer = setTimeout(() => {
        setShowCodeButton(true)
      }, 500) // 500ms delay
      return () => clearTimeout(timer)
    } else {
      setShowCodeButton(false)
    }
  }, [showArtifacts])
  
  // Show generated files alert (when there are existing generated files before the Runbook was opened) when appropriate
  useEffect(() => {
    // Only show if:
    // 1. Runbook has loaded successfully
    // 2. Generated files check has completed
    // 3. Files exist in the output directory
    // 4. User hasn't dismissed it this session
    // 5. User hasn't checked "don't ask again" in localStorage
    if (
      !getRunbookResult.isLoading &&
      !generatedFilesCheck.isLoading &&
      generatedFilesCheck.data?.hasFiles &&
      !alertDismissedThisSession &&
      shouldShowGeneratedFilesAlert()
    ) {
      setShowGeneratedFilesAlert(true);
    }
  }, [
    getRunbookResult.isLoading,
    generatedFilesCheck.isLoading,
    generatedFilesCheck.data?.hasFiles,
    alertDismissedThisSession,
  ]);
  
  // Extract commonly used values
  // Prefer remoteSource (original GitHub/GitLab URL) over local temp path for display
  const pathName = getRunbookResult.data?.remoteSource || getRunbookResult.data?.path || ''
  const content = getRunbookResult.data?.content || ''
  const runbookPath = getDirectoryPath(getRunbookResult.data?.path || '')

  // Handle closing the generated files alert
  const handleCloseAlert = () => {
    setShowGeneratedFilesAlert(false);
    setAlertDismissedThisSession(true);
  };

  // Handle successful deletion of generated files
  const handleFilesDeleted = () => {
    setShowGeneratedFilesAlert(false);
    setAlertDismissedThisSession(true);
    // Optionally refetch the file tree to clear it from the UI
    // The file tree context doesn't expose a clear method, so we'll just close the alert
  };

  return (
    <>
      <div className="flex flex-col">
        <Header pathName={pathName} localPath={getRunbookResult.data?.path} />
        
        {/* Error Summary Banner */}
        {(errorCount > 0 || warningCount > 0) && (
          <ErrorSummaryBanner 
            errorCount={errorCount} 
            warningCount={warningCount} 
            className="fixed top-15 left-1/2 -translate-x-1/2 z-50 shadow-md max-w-2xl"
          />
        )}
        
        {/* Loading and Error States */}
        {getRunbookResult.isLoading ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading runbook...</p>
            </div>
          </div>
        ) : generatedFilesCheck.error ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-xl mx-auto p-6">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-left">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-lg font-medium text-red-800 mb-2 text-center">Invalid Output Path</h3>
                <p className="text-red-700 mb-4 text-center">{generatedFilesCheck.error.message}</p>
                <div className="bg-red-100 rounded-md p-4 text-sm text-red-800">
                  <p className="mb-2">
                    When you launched Runbooks, you specified an <code className="bg-red-200 px-1 rounded">--output-path</code> of{' '}
                    <code className="bg-red-200 px-1 rounded font-mono">
                      {generatedFilesCheck.error.context?.specifiedPath || '(unknown)'}
                    </code>, but the path must be within the current working directory.
                  </p>
                  <p>
                    Your current working directory is{' '}
                    <code className="bg-red-200 px-1 rounded font-mono">
                      {generatedFilesCheck.error.context?.currentWorkingDir || '(unknown)'}
                    </code>
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (getRunbookResult.error?.message || getRunbookResult.error?.details) ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-md mx-auto p-6">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-lg font-medium text-red-800 mb-2">Failed to Load Runbook</h3>
                <p className="text-red-700 mb-2">{getRunbookResult.error?.message}</p>
                <p className="text-sm text-red-600 mb-4">
                  {getRunbookResult.error?.details}
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
            {/* Mobile Navigation - Fixed position toggle, visible only on small screens */}
            <div className="lg:hidden flex items-center justify-center mb-6 fixed top-18 left-1/2 -translate-x-1/2 transition-all duration-300 ease-in-out z-10">
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

            {/* Single MDXContainer that adapts to screen size - used by both mobile and desktop views */}
            <div className="lg:m-6 lg:mt-0 translate translate-y-19 lg:mb-20 pt-20 lg:pt-0">
              <div className="flex flex-col lg:flex-row gap-0 lg:gap-8 lg:h-[calc(100vh-5rem)] lg:overflow-hidden justify-start lg:justify-center">
                
                {/* MDX Container - Single instance with responsive visibility
                    Desktop: always visible, sizing depends on artifacts panel
                    Mobile: visible only when 'markdown' tab is active */}
                <div className={cn(
                  'relative w-full px-4 lg:px-0 lg:block',
                  {
                    'lg:flex-1 lg:max-w-3xl lg:min-w-xl': showArtifacts,
                    'lg:w-full lg:max-w-4xl': !showArtifacts,
                    'hidden': activeMobileSection !== 'markdown',
                  }
                )}>
                  <MDXContainer 
                    content={content}
                    runbookPath={runbookPath}
                    className="p-6 lg:p-8 w-full h-full max-h-[calc(100vh-9.5rem)] lg:max-h-full"
                  />
                  
                  {/* Show code icon button - desktop only, when artifacts panel is hidden */}
                  {showCodeButton && (
                    <button
                      onClick={() => setIsArtifactsHidden(false)}
                      className="hidden lg:block absolute -right-14 top-0 p-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 z-10 cursor-pointer"
                      title="Show generated files"
                    >
                      <Code className="w-5 h-5 text-gray-600" />
                    </button>
                  )}
                </div>

                {/* Artifacts - Desktop layout (grows/shrinks width smoothly) */}
                <div 
                  className={`hidden lg:block relative max-w-4xl transition-all duration-700 ease-in-out overflow-hidden ${
                    showArtifacts ? 'flex-2' : 'w-0'
                  }`}
                >
                  <ArtifactsContainer 
                    className="absolute top-0 left-0 right-0 h-full" 
                    onHide={() => setIsArtifactsHidden(true)}
                    hideContent={!showArtifacts}
                    absoluteOutputPath={generatedFilesCheck.data?.absoluteOutputPath}
                    relativeOutputPath={generatedFilesCheck.data?.relativeOutputPath}
                  />
                </div>

                {/* Artifacts - Mobile layout (shown when 'code' tab is active) */}
                <div className={`lg:hidden px-4 ${activeMobileSection === 'code' ? 'block' : 'hidden'}`}>
                  <div className="w-full h-[calc(100vh-12rem)] border border-gray-200 rounded-lg shadow-md overflow-hidden">
                    <ArtifactsContainer
                      className="w-full h-full"
                      onHide={() => setIsArtifactsHidden(true)}
                      absoluteOutputPath={generatedFilesCheck.data?.absoluteOutputPath}
                      relativeOutputPath={generatedFilesCheck.data?.relativeOutputPath}
                    />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      
      {/* Generated Files Alert Dialog */}
      {generatedFilesCheck.data && (
        <GeneratedFilesAlert
          isOpen={showGeneratedFilesAlert}
          fileCount={generatedFilesCheck.data.fileCount}
          absoluteOutputPath={generatedFilesCheck.data.absoluteOutputPath}
          onClose={handleCloseAlert}
          onDeleted={handleFilesDeleted}
        />
      )}
    </>
  )
}

export default App