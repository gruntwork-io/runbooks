import '../css/App.css'
import '../css/github-markdown.css'
import '../css/github-markdown-light.css'
import { useState, useEffect, useCallback } from 'react'
import { BookOpen, Code, AlertTriangle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import { Header } from '../components/layout/Header'
import { ErrorSummaryBanner } from '../components/layout/ErrorSummaryBanner'
import { DriftBanner } from '../components/DriftBanner'
import MDXContainer from '../components/MDXContainer'
import { ArtifactsContainer } from '../components/layout/ArtifactsContainer'
import { ViewContainerToggle } from '../components/layout/ViewContainerToggle'
import { GeneratedFilesAlert, shouldShowGeneratedFilesAlert } from '../components/layout/GeneratedFilesAlert'
import { getDirectoryPath, hasGeneratedFiles } from '../lib/utils'
import { useGetGruntbook } from '../hooks/useApiGetGruntbook'
import { useGeneratedFiles } from '../hooks/useGeneratedFiles'
import { useGitWorkTree } from '../contexts/useGitWorkTree'
import { useAuthorMode } from '../contexts/useAuthorMode'
import { useWatchMode, type DriftChange } from '../hooks/useWatchMode'
import { useApiGeneratedFilesCheck } from '../hooks/useApiGeneratedFilesCheck'
import { useErrorReporting } from '../contexts/useErrorReporting'
import { cn } from '../lib/utils'
import * as WelcomeService from '../bindings/github.com/gruntwork-io/runbooks/services/welcomeservice'
import { SessionProvider } from '../contexts/SessionContext'
import { ErrorReportingProvider } from '../contexts/ErrorReportingContext'
import { ExecutableRegistryProvider } from '../contexts/ExecutableRegistryContext'
import { GeneratedFilesProvider } from '../contexts/GeneratedFilesContext'
import { GitWorkTreeProvider } from '../contexts/GitWorkTreeContext'
import { LogsProvider } from '../contexts/LogsContext'

export interface RunbookViewProps {
  /**
   * onClose, when provided, renders a close button in the top-right
   * that returns the user to the Welcome screen after a confirmation
   * prompt. Omitted in the browser path, where there is no Welcome
   * screen to go back to.
   */
  onClose?: () => void
}

/**
 * RunbookView renders the full gruntbook experience: header, MDX body,
 * generated-files panel, and every provider the runbook path depends on
 * (session, error reporting, generated files, git worktrees, logs).
 *
 * Wrapping all of these here — instead of at the app root — means the
 * Welcome screen doesn't pay the cost of initialising a session or
 * mounting the MDX subtree, and it keeps the provider boundary
 * co-located with the code that actually needs them.
 */
export function RunbookView({ onClose }: RunbookViewProps = {}) {
  return (
    <SessionProvider>
      <ErrorReportingProvider>
        <ExecutableRegistryProvider>
          <GeneratedFilesProvider>
            <GitWorkTreeProvider>
              <LogsProvider>
                <RunbookViewBody onClose={onClose} />
              </LogsProvider>
            </GitWorkTreeProvider>
          </GeneratedFilesProvider>
        </ExecutableRegistryProvider>
      </ErrorReportingProvider>
    </SessionProvider>
  )
}

function RunbookViewBody({ onClose }: RunbookViewProps) {
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'code'>('markdown')
  const [isArtifactsHidden, setIsArtifactsHidden] = useState(true)
  const [showCodeButton, setShowCodeButton] = useState(false)
  const [showGeneratedFilesAlert, setShowGeneratedFilesAlert] = useState(false)
  const [alertDismissedThisSession, setAlertDismissedThisSession] = useState(false)
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false)
  const [driftChanges, setDriftChanges] = useState<DriftChange[]>([])
  const [driftDismissed, setDriftDismissed] = useState(false)

  const getGruntbookResult = useGetGruntbook()

  const generatedFilesCheck = useApiGeneratedFilesCheck()

  const { errorCount, warningCount, clearAllErrors } = useErrorReporting()
  const { isAuthorMode } = useAuthorMode()

  useEffect(() => {
    if (getGruntbookResult.data?.content) {
      clearAllErrors()
    }
  }, [getGruntbookResult.data?.content, clearAllErrors])

  const handleFileChange = useCallback(() => {
    console.log('[RunbookView] Gruntbook file changed, reloading...')

    if (isAuthorMode) {
      getGruntbookResult.silentRefetch()
    } else {
      getGruntbookResult.refetch()
    }
  }, [getGruntbookResult, isAuthorMode])

  const handleDrift = useCallback((event: { changes: DriftChange[] }) => {
    setDriftChanges(event.changes)
    setDriftDismissed(false)
  }, [])

  const { resetSnapshot } = useWatchMode({
    gruntbookPath: getGruntbookResult.data?.path,
    outputRelPath: generatedFilesCheck.data?.relativeOutputPath,
    isAuthorMode,
    onFileChange: handleFileChange,
    onDrift: handleDrift,
  })

  const handleDriftReload = useCallback(async () => {
    await resetSnapshot()
    setDriftChanges([])
    setDriftDismissed(false)
    getGruntbookResult.refetch()
  }, [resetSnapshot, getGruntbookResult])

  const handleDriftDismiss = useCallback(() => {
    setDriftDismissed(true)
  }, [])

  const { fileTree, updateGeneratedFileTree } = useGeneratedFiles()
  const hasFiles = hasGeneratedFiles(fileTree)

  const { workTrees } = useGitWorkTree()
  const hasWorkTrees = workTrees.length > 0

  const showArtifacts = !isArtifactsHidden

  useEffect(() => {
    if (hasFiles) {
      setIsArtifactsHidden(false)
      if (activeMobileSection === 'markdown') {
        setActiveMobileSection('code')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTree, hasFiles])

  useEffect(() => {
    if (hasWorkTrees) {
      setIsArtifactsHidden(false)
      if (activeMobileSection === 'markdown') {
        setActiveMobileSection('code')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWorkTrees])

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

  useEffect(() => {
    if (
      !getGruntbookResult.isLoading &&
      !generatedFilesCheck.isLoading &&
      generatedFilesCheck.data?.hasFiles &&
      !alertDismissedThisSession &&
      shouldShowGeneratedFilesAlert()
    ) {
      setShowGeneratedFilesAlert(true)
    }
  }, [
    getGruntbookResult.isLoading,
    generatedFilesCheck.isLoading,
    generatedFilesCheck.data?.hasFiles,
    alertDismissedThisSession,
  ])

  const pathName = getGruntbookResult.data?.remoteSource || getGruntbookResult.data?.path || ''
  const content = getGruntbookResult.data?.content || ''
  const gruntbookPath = getDirectoryPath(getGruntbookResult.data?.path || '')

  const handleCloseAlert = () => {
    setShowGeneratedFilesAlert(false)
    setAlertDismissedThisSession(true)
  }

  const handleFilesDeleted = () => {
    setShowGeneratedFilesAlert(false)
    setAlertDismissedThisSession(true)
    updateGeneratedFileTree(null)
  }

  return (
    <>
      <div className="flex flex-col">
        <Header
          pathName={pathName}
          localPath={getGruntbookResult.data?.path}
          onClose={onClose ? () => setIsCloseDialogOpen(true) : undefined}
        />

        {onClose && (
          <CloseGruntbookDialog
            open={isCloseDialogOpen}
            onOpenChange={setIsCloseDialogOpen}
            onClose={onClose}
          />
        )}

        {(errorCount > 0 || warningCount > 0) && (
          <ErrorSummaryBanner
            errorCount={errorCount}
            warningCount={warningCount}
            className="fixed top-15 left-1/2 -translate-x-1/2 z-50 shadow-md max-w-2xl"
          />
        )}

        {!isAuthorMode &&
          !driftDismissed &&
          driftChanges.length > 0 && (
            <div className="fixed top-15 left-0 right-0 z-40 shadow-md">
              <DriftBanner
                changes={driftChanges}
                onReload={handleDriftReload}
                onDismiss={handleDriftDismiss}
              />
            </div>
          )}

        {getGruntbookResult.isLoading ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading gruntbook...</p>
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
                    When you launched Gruntbooks, you specified an <code className="bg-red-200 px-1 rounded">--output-path</code> of{' '}
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
        ) : (getGruntbookResult.error?.message || getGruntbookResult.error?.details) ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-md mx-auto p-6">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-lg font-medium text-red-800 mb-2">Failed to Load Gruntbook</h3>
                <p className="text-red-700 mb-2">{getGruntbookResult.error?.message}</p>
                <p className="text-sm text-red-600 mb-4">
                  {getGruntbookResult.error?.details}
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

            <div className="lg:m-6 lg:mt-0 translate translate-y-19 lg:mb-20 pt-20 lg:pt-0">
              <div className="flex flex-col lg:flex-row gap-0 lg:gap-8 lg:h-[calc(100vh-5rem)] lg:overflow-hidden justify-start lg:justify-center">
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
                    gruntbookPath={gruntbookPath}
                    remoteSource={getGruntbookResult.data?.remoteSource}
                    className="p-6 lg:p-8 w-full h-full max-h-[calc(100vh-9.5rem)] lg:max-h-full"
                  />

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

function CloseGruntbookDialog({
  open,
  onOpenChange,
  onClose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onClose: () => void
}) {
  const [isClosing, setIsClosing] = useState(false)

  const handleConfirm = useCallback(async () => {
    setIsClosing(true)
    try {
      await WelcomeService.CloseCurrent()
    } catch (err) {
      // If shutdown fails we still navigate back to Welcome — the
      // alternative is stranding the user on a gruntbook they asked to
      // close. Log for visibility.
      console.error('[RunbookView] Failed to close gruntbook server:', err)
    } finally {
      setIsClosing(false)
      onOpenChange(false)
      onClose()
    }
  }, [onClose, onOpenChange])

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close this gruntbook?</AlertDialogTitle>
          <AlertDialogDescription>
            You’ll return to the Welcome screen. Any unsaved form input
            or in-progress commands will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isClosing}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={isClosing}>
            {isClosing ? 'Closing…' : 'Close gruntbook'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
