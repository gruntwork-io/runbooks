import './css/App.css'
import './css/github-markdown.css'
import { useState, useEffect, useCallback, useRef } from 'react'
import { BookOpen, Code, AlertTriangle } from "lucide-react"
import { Header } from './components/layout/Header'
import { WelcomeScreen } from './components/layout/WelcomeScreen'
import { OpenUrlModal } from './components/layout/OpenUrlModal'
import { ErrorSummaryBanner } from './components/layout/ErrorSummaryBanner'
import { RunbookOpenError } from './components/layout/RunbookOpenError'
import MDXContainer from './components/MDXContainer'
import { ArtifactsContainer } from './components/layout/ArtifactsContainer'
import { ViewContainerToggle } from './components/layout/ViewContainerToggle'
import { GeneratedFilesAlert, shouldShowGeneratedFilesAlert } from './components/layout/GeneratedFilesAlert'
import { getDirectoryPath, hasGeneratedFiles } from './lib/utils'
import { useIpcGetRunbook } from './hooks/useIpcGetRunbook'
import { useGeneratedFiles } from './hooks/useGeneratedFiles'
import { useGitWorkTree } from './contexts/useGitWorkTree'
import { useIpcWatchMode } from './hooks/useIpcWatchMode'
import { useIpcGeneratedFilesCheck } from './hooks/useIpcGeneratedFilesCheck'
import { useErrorReporting } from './contexts/useErrorReporting'
import { useLogs } from './contexts/useLogs'
import { useApi } from './contexts/ApiContext'
import { cn } from './lib/utils'
import type { AppError } from './types/error'

function App() {
  const api = useApi()
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'code'>('markdown')
  const [isArtifactsHidden, setIsArtifactsHidden] = useState(true);
  const [showCodeButton, setShowCodeButton] = useState(false);
  const [showGeneratedFilesAlert, setShowGeneratedFilesAlert] = useState(false);
  const [alertDismissedThisSession, setAlertDismissedThisSession] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  // The failed-open error the user dismissed from the inline banner. A new
  // failure is a new error object, so it shows the banner again.
  const [dismissedOpenError, setDismissedOpenError] = useState<AppError | null>(null);

  const handleOpenRunbook = useCallback(async () => {
    await api.invoke('native:open-runbook-dialog')
  }, [api])

  // Listen for "Open from URL" menu command
  useEffect(() => {
    const cleanup = api.on('menu:open-url-prompt', () => {
      setIsUrlModalOpen(true)
    })
    return cleanup
  }, [api])

  const getRunbookResult = useIpcGetRunbook()

  // Check for existing generated files when runbook loads.
  // Disabled until a runbook is open — the IPC handler requires a session,
  // which only exists after the main process has loaded a runbook. Keyed by
  // the runbook's path so opening a different runbook checks again.
  const generatedFilesCheck = useIpcGeneratedFilesCheck({
    disabled: !getRunbookResult.data,
    runbookPath: getRunbookResult.data?.path,
  })
  
  // Get error counts from the error reporting context (populated by MDX components)
  const { errors, errorCount, warningCount, clearAllErrors } = useErrorReporting()
  
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
  
  useIpcWatchMode(handleFileChange, getRunbookResult.data?.isWatchMode ?? false);
  
  // Get file tree state to detect when files are generated
  const { fileTree, updateGeneratedFileTree } = useGeneratedFiles()
  const hasFiles = hasGeneratedFiles(fileTree)
  
  // Get git worktree state to detect when a repo is cloned
  const { workTrees, resetWorkTrees } = useGitWorkTree()
  const hasWorkTrees = workTrees.length > 0

  const { clearLogs } = useLogs()
  
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
      }, 500)
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

  // The worktree, logs and generated-files providers are mounted once at the
  // app root, so they otherwise keep whatever the previously opened runbook
  // left there (a stale "active" repo, its logs in the download, its file
  // tree). Clear them whenever the loaded runbook actually changes, including
  // on close (the path becomes undefined), but not on watch-mode reloads,
  // which keep the same path. The per-runbook block state is reset by keying
  // MDXContainer on the same path below.
  //
  // Declared after the alert effect so its reset wins in the commit that
  // switches runbooks, when the alert effect still sees the previous
  // runbook's check result; the new runbook's check then decides.
  useEffect(() => {
    resetWorkTrees()
    clearLogs()
    updateGeneratedFileTree(null)
    setShowGeneratedFilesAlert(false)
    setAlertDismissedThisSession(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getRunbookResult.data?.path])
  
  // Prefer remoteSource (original GitHub/GitLab URL) over local temp path for display
  const pathName = getRunbookResult.data?.remoteSource || getRunbookResult.data?.path || ''
  const content = getRunbookResult.data?.content || ''
  const runbookPath = getDirectoryPath(getRunbookResult.data?.path || '')

  // Track whether we've ever successfully loaded runbook content.
  // Once true, never let loading/error states unmount MDXContainer — doing so
  // would destroy all block outputs (and user-edited inputs) stored in
  // RunbookContextProvider's React state, causing "Waiting for outputs" warnings.
  const hasEverLoadedRef = useRef(false)
  if (content) {
    hasEverLoadedRef.current = true
  }

  // Listen for "Close Runbook" menu command. useIpcGetRunbook clears its
  // own state; here we drop the "has ever loaded" latch and any error
  // banners so the WelcomeScreen renders again.
  useEffect(() => {
    const cleanup = api.on('menu:close-runbook', () => {
      hasEverLoadedRef.current = false
      clearAllErrors()
      setShowGeneratedFilesAlert(false)
      setAlertDismissedThisSession(false)
    })
    return cleanup
  }, [api, clearAllErrors])

  // A failed open after a runbook has loaded (e.g. Cmd+O on a folder with no
  // runbook.mdx) leaves the current runbook mounted, so report it in a banner
  // over it rather than the full-screen error used for the first open.
  const openError = getRunbookResult.error
  const showOpenErrorBanner =
    openError !== null && hasEverLoadedRef.current && openError !== dismissedOpenError

  // Handle closing the generated files alert
  const handleCloseAlert = () => {
    setShowGeneratedFilesAlert(false);
    setAlertDismissedThisSession(true);
  };

  // Handle successful deletion of generated files
  const handleFilesDeleted = () => {
    setShowGeneratedFilesAlert(false);
    setAlertDismissedThisSession(true);
    // Clear the file tree so stale generated files (including hidden files/folders
    // like .github) are removed from the UI after deletion
    updateGeneratedFileTree(null);
  };

  return (
    <>
      <div className="flex flex-col">
        <Header pathName={pathName} localPath={getRunbookResult.data?.path} />
        
        {/* Failed-open and Error Summary banners, stacked in one fixed
            container so they never overlap each other */}
        {(showOpenErrorBanner || errorCount > 0 || warningCount > 0) && (
          <div className="fixed top-15 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl flex flex-col items-center gap-2 pointer-events-none">
            {showOpenErrorBanner && openError && (
              <RunbookOpenError
                variant="inline"
                message={openError.message}
                currentPath={pathName}
                onChooseAnother={handleOpenRunbook}
                onRetry={() => getRunbookResult.refetch()}
                onDismiss={() => setDismissedOpenError(openError)}
                className="w-full shadow-md pointer-events-auto"
              />
            )}
            {(errorCount > 0 || warningCount > 0) && (
              <ErrorSummaryBanner
                errors={errors}
                errorCount={errorCount}
                warningCount={warningCount}
                className="shadow-md pointer-events-auto"
              />
            )}
          </div>
        )}
        
        {/* Loading and Error States
             Once content has successfully loaded (hasEverLoadedRef), skip these
             branches so MDXContainer is never unmounted. A transient isLoading
             flash (e.g. from useIpc effect re-firing) would otherwise destroy
             all block outputs and user-edited inputs stored in React state. */}
        {getRunbookResult.isLoading && !hasEverLoadedRef.current ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading runbook...</p>
            </div>
          </div>
        ) : generatedFilesCheck.error && !hasEverLoadedRef.current ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-xl mx-auto p-6">
              <div className="bg-destructive-muted border border-destructive/30 rounded-lg p-6 text-left">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-destructive-muted rounded-full">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <h3 className="text-lg font-medium text-destructive mb-2 text-center">Invalid Output Path</h3>
                <p className="text-destructive mb-4 text-center">{generatedFilesCheck.error.message}</p>
                <div className="bg-destructive-muted rounded-md p-4 text-sm text-destructive">
                  <p className="mb-2">
                    When you launched Runbooks, you specified an <code className="bg-destructive-muted px-1 rounded">--output-path</code> of{' '}
                    <code className="bg-destructive-muted px-1 rounded font-mono">
                      {generatedFilesCheck.error.context?.specifiedPath || '(unknown)'}
                    </code>, but the path must be within the current working directory.
                  </p>
                  <p>
                    Your current working directory is{' '}
                    <code className="bg-destructive-muted px-1 rounded font-mono">
                      {generatedFilesCheck.error.context?.currentWorkingDir || '(unknown)'}
                    </code>
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : getRunbookResult.error && !hasEverLoadedRef.current ? (
          <RunbookOpenError
            variant="fullscreen"
            message={getRunbookResult.error.message}
            onChooseAnother={handleOpenRunbook}
            onRetry={() => getRunbookResult.refetch()}
          />
        ) : !getRunbookResult.data && !hasEverLoadedRef.current ? (
          <WelcomeScreen onOpenUrl={() => setIsUrlModalOpen(true)} onOpenRunbook={handleOpenRunbook} />
        ) : (
          <>
            {/* Mobile Navigation - Fixed position toggle, visible only on small screens */}
            <div className="lg:hidden flex items-center justify-center mb-6 fixed top-18 left-1/2 -translate-x-1/2 transition-all duration-300 ease-in-out z-10">
              <div className="bg-muted border border-border inline-flex h-12 w-fit items-center justify-center rounded-full p-1">
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
                  {/* Keyed by the runbook's file path so opening a different
                      runbook starts from fresh block inputs/outputs and trust
                      banner, while same-path reloads keep them. */}
                  <MDXContainer
                    key={getRunbookResult.data?.path}
                    content={content}
                    runbookPath={runbookPath}
                    remoteSource={getRunbookResult.data?.remoteSource}
                    className="p-6 lg:p-8 w-full h-full max-h-[calc(100vh-9.5rem)] lg:max-h-full"
                  />
                  
                  {/* Show code icon button - desktop only, when artifacts panel is hidden */}
                  {showCodeButton && (
                    <button
                      onClick={() => setIsArtifactsHidden(false)}
                      className="hidden lg:block absolute -right-14 top-0 p-3 border border-border rounded-lg hover:bg-accent transition-all duration-200 z-10 cursor-pointer"
                      title="Show generated files"
                    >
                      <Code className="w-5 h-5 text-muted-foreground" />
                    </button>
                  )}
                </div>

                {/* Artifacts - Desktop layout (grows/shrinks width smoothly) */}
                <div 
                  className={`hidden lg:block relative max-w-7xl transition-all duration-700 ease-in-out overflow-hidden ${
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
                  <div className="w-full h-[calc(100vh-12rem)] border border-border rounded-lg shadow-md overflow-hidden">
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

      {/* Open from URL Modal */}
      <OpenUrlModal
        open={isUrlModalOpen}
        onOpenChange={setIsUrlModalOpen}
        onOpened={getRunbookResult.openRunbook}
      />
    </>
  )
}

export default App