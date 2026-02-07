import { GitBranch, CheckCircle, XCircle, Loader2, AlertTriangle, Info, Copy, Check } from "lucide-react"
import { useState, useEffect, useMemo, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ViewLogs, InlineMarkdown, BlockIdLabel } from "@/components/mdx/_shared"
import { copyTextToClipboard } from "@/lib/utils"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useGitWorkTree } from "@/contexts/GitWorkTreeContext"
import { useGitClone } from "./hooks/useGitClone"
import { GitHubBrowser } from "./components/GitHubBrowser"
import { CloneResultDisplay } from "./components/CloneResult"
import type { GitCloneProps } from "./types"

/** Parse org and repo from a GitHub URL */
function parseGitHubURL(url: string): { org: string; repo: string } | null {
  try {
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
    if (match) {
      return { org: match[1], repo: match[2] }
    }
  } catch {
    // Not a parseable URL
  }
  return null
}

function GitClone({
  id,
  title = "Clone Repository",
  description = "Enter a git URL to clone a repository",
  gitHubAuthId,
  prefilledUrl = '',
  prefilledRepoPath = '',
  prefilledLocalPath = '',
  usePty,
  showFileTree = true,
}: GitCloneProps) {
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitClone')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Git worktree context for registering cloned repos with the workspace
  const { registerWorkTree } = useGitWorkTree()

  // Track render
  useEffect(() => {
    trackBlockRender('GitClone')
  }, [id, trackBlockRender])

  // Core hook
  const {
    cloneStatus,
    logs,
    cloneResult,
    errorMessage,
    hasGitHubToken,
    tokenChecked,
    gitHubAuthMet,
    sessionReady,
    workingDir,
    clone,
    cancel,
    reset,
    checkGitHubToken,
    fetchOrgs,
    fetchRepos,
  } = useGitClone({ id, gitHubAuthId })

  // Form state
  const [gitUrl, setGitUrl] = useState(prefilledUrl)
  const [repoPath, setRepoPath] = useState(prefilledRepoPath)
  const [localPath, setLocalPath] = useState(prefilledLocalPath)
  const [copiedPathKey, setCopiedPathKey] = useState<string | null>(null)

  const handleCopyPath = useCallback(async (key: string, value: string) => {
    const ok = await copyTextToClipboard(value)
    if (ok) {
      setCopiedPathKey(key)
      setTimeout(() => setCopiedPathKey(null), 2000)
    }
  }, [])

  // Compute path preview from the current form state
  const pathPreview = useMemo(() => {
    if (!workingDir) return null

    // Determine the effective local path (defaults to repo name from URL)
    let effectivePath = localPath.trim()
    if (!effectivePath && gitUrl.trim()) {
      // Extract repo name from URL
      const match = gitUrl.trim().match(/\/([^/]+?)(?:\.git)?$/)
      if (match) effectivePath = match[1]
    }
    if (!effectivePath) return null

    const relative = effectivePath.startsWith('./') ? effectivePath : `./${effectivePath}`
    const absolute = effectivePath.startsWith('/')
      ? effectivePath
      : `${workingDir}/${effectivePath.replace(/^\.\//, '')}`

    return { relative, absolute }
  }, [workingDir, localPath, gitUrl])

  // Check for GitHub token once session is ready and auth dependency is met
  useEffect(() => {
    if (sessionReady && gitHubAuthMet && !tokenChecked) {
      checkGitHubToken()
    }
  }, [sessionReady, gitHubAuthMet, tokenChecked, checkGitHubToken])

  // Report configuration errors
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'GitClone',
        severity: 'error',
        message: `Duplicate GitClone block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: 'GitClone',
        severity: 'error',
        message: `GitClone ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  // Register the cloned repo as a git worktree when clone succeeds
  useEffect(() => {
    if (cloneStatus === 'success' && cloneResult && showFileTree) {
      // Parse owner/repoName from the git URL
      const parsed = parseGitHubURL(gitUrl)
      registerWorkTree({
        id,
        repoUrl: gitUrl.trim(),
        repoPath: repoPath.trim() || undefined,
        localPath: cloneResult.absolutePath,
        gitInfo: {
          repoUrl: gitUrl.trim(),
          repoName: parsed?.repo ?? cloneResult.relativePath,
          repoOwner: parsed?.org ?? '',
          branch: 'main', // Will be updated from workspace tree API
          commitSha: undefined,
        },
      })
    }
    // Only run when clone status changes to success
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneStatus, cloneResult])

  // Determine if the GitHub browser should be pre-opened
  const prefilledGitHub = useMemo(() => {
    if (prefilledUrl) {
      return parseGitHubURL(prefilledUrl)
    }
    return null
  }, [prefilledUrl])

  // Overwrite confirmation state
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false)

  // Handle clone button
  const handleClone = useCallback(async (force?: boolean) => {
    if (!gitUrl.trim()) return
    setShowOverwriteConfirm(false)
    const result = await clone(gitUrl.trim(), repoPath.trim(), localPath.trim(), usePty, force)
    if (result === 'directory_exists') {
      setShowOverwriteConfirm(true)
    }
  }, [gitUrl, repoPath, localPath, clone, usePty])

  // Handle repo selected from GitHub browser
  const handleRepoSelected = useCallback((url: string) => {
    setGitUrl(url)
    setShowOverwriteConfirm(false)
  }, [])

  // Handle clone again
  const handleCloneAgain = useCallback(() => {
    reset()
    setShowOverwriteConfirm(false)
  }, [reset])

  // Status-driven styling (matches Command/Check/AwsAuth/GitHubAuth pattern)
  const statusConfig: Record<string, { bg: string; icon: typeof GitBranch; iconColor: string }> = {
    success: { bg: 'bg-green-50 border-green-200', icon: CheckCircle, iconColor: 'text-green-600' },
    fail:    { bg: 'bg-red-50 border-red-200',     icon: XCircle,     iconColor: 'text-red-600' },
    running: { bg: 'bg-blue-50 border-blue-200',    icon: Loader2,     iconColor: 'text-blue-600' },
    pending: { bg: 'bg-gray-100 border-gray-200',   icon: GitBranch,   iconColor: 'text-gray-500' },
    ready:   { bg: 'bg-gray-100 border-gray-200',   icon: GitBranch,   iconColor: 'text-gray-500' },
  }

  const { bg: statusClasses, icon: IconComponent, iconColor: iconClasses } = statusConfig[cloneStatus] ?? statusConfig.pending

  const isFormDisabled = cloneStatus === 'running' || !gitHubAuthMet
  const isCloneDisabled = isFormDisabled || !gitUrl.trim()

  // If configuration error, don't render the block
  if (isDuplicate || isNormalizedCollision) {
    return null
  }

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Main container with left icon column */}
      <div className="flex @container">
        <div className="border-r border-gray-300 pr-2 mr-4 flex flex-col items-center">
          <IconComponent className={`size-6 ${iconClasses} ${cloneStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1 space-y-2">
          {/* Title and description */}
          <div className="text-md font-bold text-gray-700">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          <div className="text-md text-gray-600 mb-3">
            <InlineMarkdown>{description}</InlineMarkdown>
          </div>

          {/* Blocked state: waiting for GitHubAuth */}
          {!gitHubAuthMet && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800 m-0">Waiting for GitHub authentication</p>
                <p className="text-xs text-amber-600 m-0 mt-0.5">
                  Complete the &apos;{gitHubAuthId}&apos; GitHubAuth block above before cloning.
                </p>
              </div>
            </div>
          )}

          {/* Success state */}
          {cloneStatus === 'success' && cloneResult ? (
            <CloneResultDisplay result={cloneResult} onCloneAgain={handleCloneAgain} />
          ) : (
            /* Form state (ready, running, fail) */
            <div className="space-y-3">
              {/* Separator */}
              <div className="border-b border-gray-300"></div>

              {/* Git URL input */}
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">
                  Git URL
                </label>
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  disabled={isFormDisabled}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
                />
              </div>

              {/* GitHub Browser (only if token available) */}
              {tokenChecked && hasGitHubToken && (
                <GitHubBrowser
                  onRepoSelected={handleRepoSelected}
                  fetchOrgs={fetchOrgs}
                  fetchRepos={fetchRepos}
                  disabled={isFormDisabled}
                  initialOrg={prefilledGitHub?.org}
                  initialRepo={prefilledGitHub?.repo}
                  defaultOpen={!!prefilledGitHub}
                />
              )}

              {/* Repo Path (sparse checkout) */}
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  Repo Path <span className="font-normal text-gray-400">(optional)</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[280px]">
                      Clone only a specific subdirectory of the repository using sparse checkout. For example, <code>modules/vpc</code> would clone only that path instead of the entire repo.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <input
                  type="text"
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder="e.g., modules/vpc"
                  disabled={isFormDisabled}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
                />
              </div>

              {/* Local Path (destination) */}
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  Local Path <span className="font-normal text-gray-400">(optional)</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[280px]">
                      The directory where the cloned files will be saved, relative to the current working directory. Defaults to the repository name if not specified.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <input
                  type="text"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="Defaults to repo name"
                  disabled={isFormDisabled}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
                />
                {pathPreview && (
                  <div className="mt-1.5 text-xs text-gray-500 space-y-0.5">
                    <div className="flex items-center gap-1">
                      <span className="text-gray-400">Relative:</span>
                      <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-gray-600">{pathPreview.relative}</code>
                      <button
                        onClick={() => handleCopyPath('relative', pathPreview.relative)}
                        className="shrink-0 p-0.5 text-gray-400 hover:text-gray-600 cursor-pointer"
                      >
                        {copiedPathKey === 'relative' ? (
                          <Check className="size-3 text-green-600" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-400">Absolute:</span>
                      <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-gray-600">{pathPreview.absolute}</code>
                      <button
                        onClick={() => handleCopyPath('absolute', pathPreview.absolute)}
                        className="shrink-0 p-0.5 text-gray-400 hover:text-gray-600 cursor-pointer"
                      >
                        {copiedPathKey === 'absolute' ? (
                          <Check className="size-3 text-green-600" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Error message */}
              {errorMessage && cloneStatus === 'fail' && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
                  <XCircle className="size-4 text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-800 m-0">Clone failed</p>
                    <p className="text-xs text-red-600 m-0 mt-0.5 font-mono">{errorMessage}</p>
                  </div>
                </div>
              )}

              {/* Overwrite confirmation */}
              {showOverwriteConfirm && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2">
                  <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-amber-800 m-0">Local path already exists</p>
                    <p className="text-xs text-amber-600 m-0 mt-0.5">
                      The local path (destination directory) is not empty. Delete it and continue with git clone?
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleClone(true)}
                      >
                        Delete &amp; Clone
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowOverwriteConfirm(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              {!showOverwriteConfirm && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={isCloneDisabled}
                    onClick={() => handleClone()}
                  >
                    {cloneStatus === 'running' ? (
                      <>
                        <Loader2 className="size-4 mr-1 animate-spin" />
                        Cloning...
                      </>
                    ) : (
                      'Clone'
                    )}
                  </Button>
                  {cloneStatus === 'running' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancel}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* View Logs - below main content */}
      {logs.length > 0 && (
        <div className="mt-4 space-y-2">
          <ViewLogs
            logs={logs}
            status={cloneStatus === 'running' ? 'running' : cloneStatus === 'success' ? 'success' : cloneStatus === 'fail' ? 'fail' : 'pending'}
            autoOpen={cloneStatus === 'running'}
            blockId={id}
          />
        </div>
      )}
    </div>
  )
}

// Set displayName for React DevTools and component detection
GitClone.displayName = 'GitClone';

export default GitClone;
