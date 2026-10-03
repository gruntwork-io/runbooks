import "./css/App.css"
import "./css/github-markdown.css"
import { useState, useEffect, useCallback, useRef } from "react"
import { BookOpen, Code } from "lucide-react"
import { Header } from "./components/layout/Header"
import { WelcomeScreen } from "./components/layout/WelcomeScreen"
import { OpenUrlModal } from "./components/layout/OpenUrlModal"
import { FindBar } from "./components/layout/FindBar"
import { ErrorSummaryBanner } from "./components/layout/ErrorSummaryBanner"
import { RunbookOpenError } from "./components/layout/RunbookOpenError"
import { SessionResumedNotice } from "./components/layout/SessionResumedNotice"
import MDXContainer from "./components/MDXContainer"
import { ArtifactsContainer } from "./components/layout/ArtifactsContainer"
import { ViewContainerToggle } from "./components/layout/ViewContainerToggle"
import {
  GeneratedFilesAlert,
  shouldShowGeneratedFilesAlert,
} from "./components/layout/GeneratedFilesAlert"
import { getDirectoryPath, hasGeneratedFiles } from "./lib/utils"
import { useIpcGetRunbook } from "./hooks/useIpcGetRunbook"
import { useGeneratedFiles } from "./hooks/useGeneratedFiles"
import { useGitWorkTree } from "./contexts/useGitWorkTree"
import { useIpcWatchMode } from "./hooks/useIpcWatchMode"
import { useIpcGeneratedFilesCheck } from "./hooks/useIpcGeneratedFilesCheck"
import { useWheelScrollFallback } from "./hooks/useWheelScrollFallback"
import { useErrorReporting } from "./contexts/useErrorReporting"
import { useLogs } from "./contexts/useLogs"
import { useApi } from "./contexts/ApiContext"
import { IpcSessionHistoryProvider } from "./contexts/IpcSessionHistoryContext"
import { cn } from "./lib/utils"
import type { AppError } from "./types/error"

/** The window title while no runbook is open, as in index.html. */
const APP_TITLE = "Gruntwork Runbooks"

/**
 * Clears the root logs store whenever the loaded runbook or its session
 * changes, including on close (the key becomes undefined), so the previous
 * runbook's logs don't end up in the "download logs" zip.
 *
 * A separate child so App itself doesn't read LogsContext: its value changes
 * whenever hasLogs flips (e.g. on the first log line, or a clear), and App
 * re-rendering would re-render the whole runbook. Its effect runs before App's
 * in the same commit, which is fine, because the next runbook's blocks only
 * register logs once its MDX has compiled.
 */
function ClearLogsOnRunbookChange({ sessionKey }: { sessionKey?: string | undefined }) {
  const { clearLogs } = useLogs()
  useEffect(() => {
    clearLogs()
  }, [sessionKey, clearLogs])
  return null
}

function App() {
  const api = useApi()
  const [activeMobileSection, setActiveMobileSection] = useState<"markdown" | "code">("markdown")
  const [isArtifactsHidden, setIsArtifactsHidden] = useState(true)
  const [showCodeButton, setShowCodeButton] = useState(false)
  const [showGeneratedFilesAlert, setShowGeneratedFilesAlert] = useState(false)
  const [alertDismissedThisSession, setAlertDismissedThisSession] = useState(false)
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false)
  // The failed-open error the user dismissed from the inline banner. A new
  // failure is a new error object, so it shows the banner again.
  const [dismissedOpenError, setDismissedOpenError] = useState<AppError | null>(null)
  const runbookScrollRef = useRef<HTMLDivElement>(null)
  const handleWheel = useWheelScrollFallback(runbookScrollRef)

  const handleOpenRunbook = useCallback(async () => {
    await api.invoke("native:open-runbook-dialog")
  }, [api])

  // Listen for "Open from URL" menu command
  useEffect(() => {
    const cleanup = api.on("menu:open-url-prompt", () => {
      setIsUrlModalOpen(true)
    })
    return cleanup
  }, [api])

  const getRunbookResult = useIpcGetRunbook()

  // The loaded runbook together with the session it was opened in. File > New
  // Session reloads the same path under a new session, and has to reset
  // everything that opening a different runbook resets.
  const loadedSessionKey = getRunbookResult.data
    ? `${getRunbookResult.data.path}\n${getRunbookResult.data.sessionId ?? ""}`
    : undefined

  // Check for existing generated files when runbook loads.
  // Disabled until a runbook is open — the IPC handler requires a session,
  // which only exists after the main process has loaded a runbook. Keyed by
  // the session so opening a different runbook or session checks again.
  const generatedFilesCheck = useIpcGeneratedFilesCheck({
    disabled: !getRunbookResult.data,
    sessionKey: loadedSessionKey,
  })

  // Get error counts from the error reporting context (populated by MDX components)
  const { errors, errorCount, warningCount, clearAllErrors } = useErrorReporting()

  // Clear errors when runbook content changes (to avoid stale errors)
  useEffect(() => {
    if (getRunbookResult.data?.content) {
      clearAllErrors()
    }
  }, [getRunbookResult.data?.content, clearAllErrors])

  // Watch mode: reload the runbook, without a loading flash, when the main
  // process reports that the runbook it watches changed. A failed open leaves
  // the previous runbook on screen, and main keeps watching it, while the last
  // request is the failed one: re-sending that would raise its error again on
  // every save, so reload the displayed runbook instead.
  const { data: displayedRunbook, error: runbookError, reloadForWatch } = getRunbookResult
  const handleRunbookFileChange = useCallback(
    (changedPath: string) => {
      if (runbookError && displayedRunbook?.path === changedPath) {
        reloadForWatch(displayedRunbook.path, displayedRunbook.remoteSource)
      } else {
        reloadForWatch()
      }
    },
    [runbookError, displayedRunbook, reloadForWatch],
  )
  useIpcWatchMode(handleRunbookFileChange, displayedRunbook?.isWatchMode ?? false)

  // Get file tree state to detect when files are generated
  const { fileTree, updateGeneratedFileTree } = useGeneratedFiles()
  const hasFiles = hasGeneratedFiles(fileTree)

  // Get git worktree state to detect when a repo is cloned
  const { workTrees, resetWorkTrees } = useGitWorkTree()
  const hasWorkTrees = workTrees.length > 0

  // Show artifacts panel unless user has manually hidden it
  const showArtifacts = !isArtifactsHidden

  // Hides the "show code" button along with showing the panel, so the button
  // waits out its delay again the next time the panel is hidden.
  const revealArtifacts = () => {
    setIsArtifactsHidden(false)
    setShowCodeButton(false)
  }

  // Auto-show artifacts panel and switch mobile view when files are
  // generated/regenerated, or when a git worktree is registered (repo cloned).
  // Only a change of either triggers it, so the user's own mobile toggle sticks.
  const [prevFileTree, setPrevFileTree] = useState<typeof fileTree>(null)
  const [prevHasWorkTrees, setPrevHasWorkTrees] = useState(false)
  if (fileTree !== prevFileTree || hasWorkTrees !== prevHasWorkTrees) {
    setPrevFileTree(fileTree)
    setPrevHasWorkTrees(hasWorkTrees)
    const filesGenerated = fileTree !== prevFileTree && hasFiles
    const repoCloned = hasWorkTrees !== prevHasWorkTrees && hasWorkTrees
    if (filesGenerated || repoCloned) {
      revealArtifacts()
      if (activeMobileSection === "markdown") {
        setActiveMobileSection("code")
      }
    }
  }

  // Delay showing the "show code" button to avoid awkward appearance during closing animation
  useEffect(() => {
    if (showArtifacts) return
    const timer = setTimeout(() => {
      setShowCodeButton(true)
    }, 500)
    return () => clearTimeout(timer)
  }, [showArtifacts])

  // The check result on screen when the loaded runbook last changed. It
  // belongs to the previous runbook: the check for the new one only starts
  // loading in the commit that switches runbooks.
  const [staleFilesCheck, setStaleFilesCheck] = useState(generatedFilesCheck.data)

  // Show generated files alert (when there are existing generated files before
  // the Runbook was opened) once all of these hold:
  // 1. Runbook has loaded successfully
  // 2. Generated files check has completed for this runbook
  // 3. Files exist in the output directory
  // 4. User hasn't dismissed it this session
  // 5. User hasn't checked "don't ask again" in localStorage
  // It then stays open until dismissed or the runbook changes.
  // A session whose blocks resume from its history is not asked about: its
  // files are what those blocks left, and its Generated panel shows them.
  const resumesBlocks = (getRunbookResult.data?.blockStates?.length ?? 0) > 0
  const alertReady = Boolean(
    !resumesBlocks &&
    !getRunbookResult.isLoading &&
    !generatedFilesCheck.isLoading &&
    generatedFilesCheck.data !== staleFilesCheck &&
    generatedFilesCheck.data?.hasFiles &&
    !alertDismissedThisSession &&
    shouldShowGeneratedFilesAlert(),
  )
  const [prevAlertReady, setPrevAlertReady] = useState(false)
  if (alertReady !== prevAlertReady) {
    setPrevAlertReady(alertReady)
    if (alertReady) setShowGeneratedFilesAlert(true)
  }

  // Reset the generated-files alert whenever the loaded runbook or its session
  // actually changes, including on close (the key becomes undefined), but not
  // on watch-mode reloads, which keep both. Done after the alert update
  // above, so this reset wins in the render that switches runbooks.
  const [prevLoadedSessionKey, setPrevLoadedSessionKey] = useState(loadedSessionKey)
  if (loadedSessionKey !== prevLoadedSessionKey) {
    setPrevLoadedSessionKey(loadedSessionKey)
    setStaleFilesCheck(generatedFilesCheck.data)
    setShowGeneratedFilesAlert(false)
    setAlertDismissedThisSession(false)
  }

  // The worktree and generated-files providers are mounted once at the app
  // root, so they otherwise keep whatever the previously opened runbook left
  // there (a stale "active" repo, its file tree). Clear them on the same
  // changes as the alert above. The per-runbook block state is reset by
  // keying MDXContainer's session history provider on the same key below, and
  // the logs store by ClearLogsOnRunbookChange. Both setters are stable, so
  // only a change of the key re-runs this.
  useEffect(() => {
    resetWorkTrees()
    updateGeneratedFileTree(null)
  }, [loadedSessionKey, resetWorkTrees, updateGeneratedFileTree])

  // The files a resumed session's blocks wrote, once the check for this
  // session has read them.
  const resumedFiles =
    resumesBlocks && generatedFilesCheck.data !== staleFilesCheck
      ? generatedFilesCheck.data
      : undefined
  useEffect(() => {
    if (!resumedFiles?.fileTree) return
    updateGeneratedFileTree({
      fileTree: resumedFiles.fileTree,
      truncatedTree: resumedFiles.truncatedTree,
      totalFiles: resumedFiles.totalFiles,
      heavyDirs: resumedFiles.heavyDirs,
    })
  }, [resumedFiles, updateGeneratedFileTree])

  // Prefer remoteSource (original GitHub/GitLab URL) over local temp path for display
  const pathName = getRunbookResult.data?.remoteSource || getRunbookResult.data?.path || ""
  const content = getRunbookResult.data?.content || ""
  const runbookPath = getDirectoryPath(getRunbookResult.data?.path || "")

  // The session's name goes in the Header, which is the title bar people see,
  // and in the window title, which the OS shows in its window list and taskbar.
  // A rename from the Header takes effect here at once: the loaded runbook's
  // data only has the new name after its next load.
  const loadedSessionId = getRunbookResult.data?.sessionId
  const [renamed, setRenamed] = useState<{ sessionId: string | undefined; name: string } | null>(
    null,
  )
  const sessionName =
    renamed !== null && renamed.sessionId === loadedSessionId
      ? renamed.name
      : getRunbookResult.data?.sessionName
  useEffect(() => {
    document.title = sessionName ? `${sessionName} - ${APP_TITLE}` : APP_TITLE
  }, [sessionName])

  // Says that opening the runbook resumed a saved session with history. Only
  // the load that resumed it says when it was last used, so the notice is kept
  // through later reloads in that session, until dismissed.
  const [resumeNotice, setResumeNotice] = useState<{
    sessionKey: string
    resumedFrom: string
  } | null>(null)
  const [prevRunbookData, setPrevRunbookData] = useState(getRunbookResult.data)
  if (getRunbookResult.data !== prevRunbookData) {
    setPrevRunbookData(getRunbookResult.data)
    const resumedFrom = getRunbookResult.data?.sessionResumedFrom
    if (loadedSessionKey && resumedFrom && resumesBlocks) {
      setResumeNotice({ sessionKey: loadedSessionKey, resumedFrom })
    }
  }
  const shownResumeNotice =
    resumeNotice !== null && resumeNotice.sessionKey === loadedSessionKey && sessionName
      ? { ...resumeNotice, sessionName }
      : null
  const handleStartNewSession = () => {
    setResumeNotice(null)
    api.invoke("native:reset-session").catch((err: unknown) => {
      console.error("Failed to reset the session:", err)
    })
  }

  // Track whether we've ever successfully loaded runbook content.
  // Once true, never let loading/error states unmount MDXContainer — doing so
  // would destroy all block outputs (and user-edited inputs) stored in
  // RunbookContextProvider's React state, causing "Waiting for outputs" warnings.
  const [hasEverLoaded, setHasEverLoaded] = useState(false)
  if (content && !hasEverLoaded) {
    setHasEverLoaded(true)
  }

  // Listen for "Close Runbook" menu command. useIpcGetRunbook clears its
  // own state; here we drop the "has ever loaded" latch and any error
  // banners so the WelcomeScreen renders again.
  useEffect(() => {
    const cleanup = api.on("menu:close-runbook", () => {
      setHasEverLoaded(false)
      clearAllErrors()
    })
    return cleanup
  }, [api, clearAllErrors])

  // A failed open after a runbook has loaded (e.g. Cmd+O on a folder with no
  // runbook.mdx) leaves the current runbook mounted, so report it in a banner
  // over it rather than the full-screen error used for the first open.
  const openError = getRunbookResult.error
  const showOpenErrorBanner =
    openError !== null && hasEverLoaded && openError !== dismissedOpenError

  // Handle closing the generated files alert
  const handleCloseAlert = () => {
    setShowGeneratedFilesAlert(false)
    setAlertDismissedThisSession(true)
  }

  // Handle successful deletion of generated files
  const handleFilesDeleted = () => {
    setShowGeneratedFilesAlert(false)
    setAlertDismissedThisSession(true)
    // Clear the file tree so stale generated files (including hidden files/folders
    // like .github) are removed from the UI after deletion
    updateGeneratedFileTree(null)
  }

  return (
    <>
      <ClearLogsOnRunbookChange sessionKey={loadedSessionKey} />
      {/* The runbook scrolls inside its own box, so a wheel gesture over the
          gutters beside it reaches nothing scrollable. Forward it to the runbook. */}
      <div className="flex flex-col" onWheel={handleWheel}>
        <Header
          sessionName={sessionName}
          sessionDir={getRunbookResult.data?.sessionDir}
          onSessionRenamed={(name) => setRenamed({ sessionId: loadedSessionId, name })}
        />

        {/* Failed-open and Error Summary banners, stacked in one fixed
            container so they never overlap each other */}
        {(shownResumeNotice || showOpenErrorBanner || errorCount > 0 || warningCount > 0) && (
          <div className="fixed top-15 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl flex flex-col items-center gap-2 pointer-events-none">
            {shownResumeNotice && (
              <SessionResumedNotice
                sessionName={shownResumeNotice.sessionName}
                resumedFrom={shownResumeNotice.resumedFrom}
                onStartNew={handleStartNewSession}
                onDismiss={() => setResumeNotice(null)}
                className="shadow-md pointer-events-auto"
              />
            )}
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
             Once content has successfully loaded (hasEverLoaded), skip these
             branches so MDXContainer is never unmounted. A transient isLoading
             flash (e.g. from useIpc effect re-firing) would otherwise destroy
             all block outputs and user-edited inputs stored in React state. */}
        {getRunbookResult.isLoading && !hasEverLoaded ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading runbook...</p>
            </div>
          </div>
        ) : getRunbookResult.error && !hasEverLoaded ? (
          <RunbookOpenError
            variant="fullscreen"
            message={getRunbookResult.error.message}
            onChooseAnother={handleOpenRunbook}
            onRetry={() => getRunbookResult.refetch()}
          />
        ) : !getRunbookResult.data && !hasEverLoaded ? (
          <WelcomeScreen
            onOpenUrl={() => setIsUrlModalOpen(true)}
            onOpenRunbook={handleOpenRunbook}
          />
        ) : (
          <>
            {/* Mobile Navigation - Fixed position toggle, visible only on small screens.
                data-find-ignore: find in page skips its always-visible labels. */}
            <div
              className="lg:hidden flex items-center justify-center mb-6 fixed top-18 left-1/2 -translate-x-1/2 transition-all duration-300 ease-in-out z-10"
              data-find-ignore=""
            >
              <div className="bg-muted border border-border inline-flex h-12 w-fit items-center justify-center rounded-full p-1">
                <ViewContainerToggle
                  activeView={activeMobileSection}
                  onViewChange={(view) => setActiveMobileSection(view as "markdown" | "code")}
                  views={[
                    { label: "Markdown", value: "markdown", icon: BookOpen },
                    { label: "Code", value: "code", icon: Code },
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
                <div
                  className={cn("relative w-full px-4 lg:px-0 lg:block", {
                    "lg:flex-1 lg:max-w-3xl lg:min-w-xl": showArtifacts,
                    "lg:w-full lg:max-w-4xl": !showArtifacts,
                    hidden: activeMobileSection !== "markdown",
                  })}
                >
                  {/* Keyed by the runbook's file path and session so opening
                      a different runbook, or starting a new session, starts
                      from fresh block inputs/outputs and trust banner, while
                      same-path reloads keep them. The blocks start from
                      what the session's history says they were left as. */}
                  <IpcSessionHistoryProvider
                    key={loadedSessionKey}
                    sessionId={getRunbookResult.data?.sessionId}
                    blockStates={getRunbookResult.data?.blockStates}
                  >
                    <MDXContainer
                      ref={runbookScrollRef}
                      content={content}
                      runbookPath={runbookPath}
                      runbookFilePath={getRunbookResult.data?.path}
                      remoteSource={getRunbookResult.data?.remoteSource}
                      assetHost={getRunbookResult.data?.assetHost}
                      className="p-6 lg:p-8 w-full h-full max-h-[calc(100vh-9.5rem)] lg:max-h-full"
                    />
                  </IpcSessionHistoryProvider>

                  {/* Show code icon button - desktop only, when artifacts panel is hidden */}
                  {showCodeButton && (
                    <button
                      onClick={revealArtifacts}
                      className="hidden lg:block absolute -right-14 top-0 p-3 border border-border rounded-lg hover:bg-accent transition-all duration-200 z-10 cursor-pointer"
                      title="Show generated files"
                    >
                      <Code className="w-5 h-5 text-muted-foreground" />
                    </button>
                  )}
                </div>

                {/* Artifacts - Desktop layout (grows/shrinks width smoothly).
                    Inert while hidden: it stays mounted at zero width, and
                    find in page and the keyboard must skip its content. */}
                <div
                  className={`hidden lg:block relative max-w-7xl transition-all duration-700 ease-in-out overflow-hidden ${
                    showArtifacts ? "flex-2" : "w-0"
                  }`}
                  inert={!showArtifacts}
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
                <div
                  className={`lg:hidden px-4 ${activeMobileSection === "code" ? "block" : "hidden"}`}
                >
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

      {/* Generated Files Alert Dialog. Keyed like the runbook's blocks so the delete
          result (success or failure) from the previous runbook doesn't
          replace the next runbook's Keep/Delete prompt. */}
      {generatedFilesCheck.data && (
        <GeneratedFilesAlert
          key={loadedSessionKey}
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

      {/* Edit > Find… (Cmd/Ctrl+F) */}
      <FindBar />
    </>
  )
}

export default App
