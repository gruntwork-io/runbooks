import { GitBranch, CheckCircle, XCircle, Loader2, AlertTriangle, Copy, Check } from "lucide-react"
import { useState, useEffect, useMemo, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { InfoTooltip } from "@/components/mdx/GitPullRequest/components/InfoTooltip"
import { ViewLogs, ViewOutputs, InlineMarkdown, BlockIdLabel } from "@/components/mdx/_shared"
import { copyTextToClipboard } from "@/lib/utils"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useOutputs } from "@/contexts/useRunbook"
import { useGitClone } from "./hooks/useGitClone"
import { GitHubBrowser } from "./components/GitHubBrowser"
import { CloneResultDisplay } from "./components/CloneResult"
import { CollapsibleToggle } from "@/components/mdx/GitPullRequest/components/CollapsibleToggle"
import { extractTemplateDependenciesFromString, splitDependencies } from "@/lib/extractTemplateDependencies"
import { useTemplateDependencies } from "@/components/mdx/_shared/hooks/useTemplateDependencies"
import { resolveTemplateReferences, filterUnmetOutputDeps } from "@/lib/templateUtils"
import { UnmetDependenciesWarning } from "@/components/mdx/_shared/components/UnmetDependenciesWarning"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { GitCloneInstruction } from "./GitCloneInstruction"
import type { AppError } from "@/types/error"
import type { GitCloneProps } from "./types"

/**
 * Parse owner and repo from a git remote URL (GitHub, GitLab, or self-hosted).
 *
 * The last path segment is the repo (project) and everything before it is the
 * owner. This handles GitHub's `owner/repo` as well as GitLab nested groups,
 * where the owner is the full group path (e.g. `group/subgroup`).
 */
function parseOwnerRepoFromURL(url: string): { org: string; repo: string } | null {
  // Extract the path after the host for both SSH (git@host:path) and HTTPS forms.
  let path: string
  const sshMatch = url.trim().match(/^git@[^:]+:(.+)$/)
  if (sshMatch) {
    path = sshMatch[1]
  } else {
    try {
      path = new URL(url.trim()).pathname
    } catch {
      // Not a parseable URL
      return null
    }
  }

  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) {
    return null
  }

  const repo = parts[parts.length - 1].replace(/\.git$/, '')
  const org = parts.slice(0, -1).join('/')
  return { org, repo }
}

function GitCloneInteractive({
  id,
  title = "Clone Repository",
  description = "Enter a git URL to clone a repository",
  inputsId,
  githubAuthId,
  gitAuthId,
  prefilledUrl = '',
  prefilledRef = '',
  prefilledRepoPath = '',
  prefilledLocalPath = '',
  usePty,
  showFileTree = true,
}: GitCloneProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <GitClone> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // --- Template dependency resolution (resolve inputs/outputs expressions) ---

  // 1. EXTRACT — discover dependencies from template-capable props
  // Blocking dependencies (functional props): prefilledUrl, prefilledRef, prefilledRepoPath, prefilledLocalPath
  const blockingDeps = useMemo(() => extractTemplateDependenciesFromString(
    [prefilledUrl, prefilledRef, prefilledRepoPath, prefilledLocalPath]
      .filter(Boolean).join('\n')
  ), [prefilledUrl, prefilledRef, prefilledRepoPath, prefilledLocalPath])

  // Non-blocking dependencies (display props): title, description
  const nonBlockingDeps = useMemo(() => extractTemplateDependenciesFromString(
    [title, description].filter(Boolean).join('\n')
  ), [title, description])

  // Combine for resolution context
  const allDeps = useMemo(() => [...blockingDeps, ...nonBlockingDeps], [blockingDeps, nonBlockingDeps])

  // 2. RESOLVE — check context for each dependency (use all deps for context)
  const { unmetInputDeps: allUnmetInputDeps, unmetOutputDeps: allUnmetOutputDeps, inputs, outputs } =
    useTemplateDependencies(allDeps, inputsId)

  // 3. Compute unmet dependencies for BLOCKING props only
  const { unmetInputDeps, unmetOutputDeps } = useMemo(() => {
    const { inputs: blockingInputDeps, outputs: blockingOutputDeps } = splitDependencies(blockingDeps)
    return {
      unmetInputDeps: allUnmetInputDeps.filter(dep => blockingInputDeps.includes(dep)),
      unmetOutputDeps: filterUnmetOutputDeps(allUnmetOutputDeps, blockingOutputDeps)
    }
  }, [blockingDeps, allUnmetInputDeps, allUnmetOutputDeps])

  const hasAllBlockingDependencies = unmetInputDeps.length === 0 && unmetOutputDeps.length === 0

  // 4. Resolve template expressions client-side (resolve ALL props, blocking + non-blocking)
  const ctx = useMemo(() => ({ inputs, outputs }), [inputs, outputs])
  const resolvedUrl = useMemo(() => resolveTemplateReferences(prefilledUrl, ctx), [prefilledUrl, ctx])
  const resolvedRef = useMemo(() => resolveTemplateReferences(prefilledRef, ctx), [prefilledRef, ctx])
  const resolvedRepoPath = useMemo(() => resolveTemplateReferences(prefilledRepoPath, ctx), [prefilledRepoPath, ctx])
  const resolvedLocalPath = useMemo(() => resolveTemplateReferences(prefilledLocalPath, ctx), [prefilledLocalPath, ctx])
  const resolvedTitle = useMemo(() => resolveTemplateReferences(title ?? 'Clone Repository', ctx), [title, ctx])
  const resolvedDescription = useMemo(() => resolveTemplateReferences(description ?? 'Enter a git URL to clone a repository', ctx), [description, ctx])

  // --- End template dependency resolution ---

  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitClone')

  const { reportError, clearError } = useErrorReporting()

  const { trackBlockRender } = useTelemetry()

  // Git worktree context for registering cloned repos with the workspace
  const { registerWorkTree } = useGitWorkTree()

  useEffect(() => {
    trackBlockRender('GitClone')
  }, [id, trackBlockRender])

  const {
    cloneStatus,
    logs,
    cloneResult,
    errorMessage,
    hasGitHubToken,
    tokenChecked,
    gitHubAuthMet,
    workingDir,
    clone,
    cancel,
    reset,
    checkGitHubToken,
    fetchOrgs,
    fetchRepos,
    fetchRefs,
  } = useGitClone({ id, githubAuthId, gitAuthId })

  const outputValues = useOutputs(id)
  const registeredOutputs = useMemo(() => {
    if (!outputValues || outputValues.length === 0) return null
    return Object.fromEntries(outputValues.map(o => [o.name, o.value]))
  }, [outputValues])

  // Form state — initialized from resolved values
  const [gitUrl, setGitUrl] = useState(resolvedUrl)
  const [ref, setRef] = useState(resolvedRef)
  const [repoPath, setRepoPath] = useState(resolvedRepoPath)
  const [localPath, setLocalPath] = useState(resolvedLocalPath)
  const [copiedPathKey, setCopiedPathKey] = useState<string | null>(null)
  const [showAdditionalSettings, setShowAdditionalSettings] = useState(
    !!(prefilledRef || prefilledRepoPath || prefilledLocalPath)
  )

  // Reactive sync: keep form state in sync with resolved template values.
  // Only needed for fields backed by useState (user-editable inputs).
  // Title and description are rendered directly from useMemo — no sync needed.
  useEffect(() => { setGitUrl(resolvedUrl) }, [resolvedUrl])
  useEffect(() => { setRef(resolvedRef) }, [resolvedRef])
  useEffect(() => { setRepoPath(resolvedRepoPath) }, [resolvedRepoPath])
  useEffect(() => { setLocalPath(resolvedLocalPath) }, [resolvedLocalPath])

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

  // Check for GitHub token once the auth dependency is met
  useEffect(() => {
    if (gitHubAuthMet && !tokenChecked) {
      checkGitHubToken()
    }
  }, [gitHubAuthMet, tokenChecked, checkGitHubToken])

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
      const parsed = parseOwnerRepoFromURL(gitUrl)
      registerWorkTree({
        id,
        repoUrl: gitUrl.trim(),
        repoPath: repoPath.trim() || undefined,
        localPath: cloneResult.absolutePath,
        gitInfo: {
          repoUrl: gitUrl.trim(),
          repoName: parsed?.repo ?? cloneResult.relativePath,
          repoOwner: parsed?.org ?? '',
          ref: ref.trim() || 'main',
          refType: undefined, // Determined by the backend when the workspace tree is fetched
          commitSha: undefined,
        },
      })
    }
    // Only run when clone status changes to success
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneStatus, cloneResult])

  // Seed the GitHub browser's org/repo, but only from GitHub URLs — feeding a
  // GitLab owner/repo into the GitHub browser would be meaningless.
  const prefilledGitHub = useMemo(() => {
    if (resolvedUrl && /(?:\/\/|@)github\.com[/:]/.test(resolvedUrl)) {
      return parseOwnerRepoFromURL(resolvedUrl)
    }
    return null
  }, [resolvedUrl])

  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false)

  const handleClone = useCallback(async (force?: boolean) => {
    if (!gitUrl.trim()) return
    setShowOverwriteConfirm(false)
    const result = await clone(gitUrl.trim(), ref.trim(), repoPath.trim(), localPath.trim(), usePty, force)
    if (result === 'directory_exists') {
      setShowOverwriteConfirm(true)
    }
  }, [gitUrl, ref, repoPath, localPath, clone, usePty])

  const handleRepoSelected = useCallback((url: string) => {
    setGitUrl(url)
    setShowOverwriteConfirm(false)
  }, [])

  const handleRefSelected = useCallback((selectedRef: string) => {
    setRef(selectedRef)
  }, [])

  const handleCloneAgain = useCallback(() => {
    reset()
    setShowOverwriteConfirm(false)
  }, [reset])

  // Status-driven styling (matches Command/Check/AwsAuth/GitHubAuth pattern)
  const statusConfig: Record<string, { bg: string; icon: typeof GitBranch; iconColor: string }> = {
    success: { bg: 'bg-success-muted border-success/30', icon: CheckCircle, iconColor: 'text-success' },
    fail:    { bg: 'bg-destructive-muted border-destructive/30',     icon: XCircle,     iconColor: 'text-destructive' },
    running: { bg: 'bg-info-muted border-info/40',    icon: Loader2,     iconColor: 'text-info' },
    pending: { bg: 'bg-muted border-border',   icon: GitBranch,   iconColor: 'text-muted-foreground' },
    ready:   { bg: 'bg-muted border-border',   icon: GitBranch,   iconColor: 'text-muted-foreground' },
  }

  const { bg: statusClasses, icon: IconComponent, iconColor: iconClasses } = statusConfig[cloneStatus] ?? statusConfig.pending

  const isFormDisabled = cloneStatus === 'running' || !gitHubAuthMet || !hasAllBlockingDependencies
  const isCloneDisabled = isFormDisabled || !gitUrl.trim()

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // If configuration error, don't render the block
  if (isDuplicate || isNormalizedCollision) {
    return null
  }

  return (
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Main container with left icon column */}
      <div className="flex @container">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <IconComponent className={`size-6 ${iconClasses} ${cloneStatus === 'running' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1 space-y-2">
          {/* Title and description */}
          <div className="text-md font-bold text-foreground">
            <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
          </div>
          <div className="text-md text-muted-foreground mb-3">
            <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
          </div>

          {/* Unmet template dependencies (blocking only) */}
          {!hasAllBlockingDependencies && (
            <UnmetDependenciesWarning
              blockType="git-clone"
              unmetInputDeps={unmetInputDeps}
              unmetOutputDeps={unmetOutputDeps}
            />
          )}

          {/* Blocked state: waiting for the referenced auth block */}
          {hasAllBlockingDependencies && !gitHubAuthMet && (
            <div className="mb-4 p-3 bg-warning-muted border border-warning/30 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-warning-foreground m-0">Waiting for git authentication</p>
                <p className="text-xs text-warning-foreground m-0 mt-0.5">
                  Complete the &apos;{githubAuthId ?? gitAuthId}&apos; authentication block above before cloning.
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
              <div className="border-b border-border"></div>

              {/* Git URL input */}
              <div>
                <label className="text-sm font-medium text-foreground mb-1 block">
                  Git URL
                </label>
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  disabled={isFormDisabled}
                  className="w-full px-3 py-2 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"
                />
              </div>

              {/* GitHub Browser (only if token available) */}
              {tokenChecked && hasGitHubToken && (
                <GitHubBrowser
                  onRepoSelected={handleRepoSelected}
                  onRefSelected={handleRefSelected}
                  fetchOrgs={fetchOrgs}
                  fetchRepos={fetchRepos}
                  fetchRefs={fetchRefs}
                  disabled={isFormDisabled}
                  initialOrg={prefilledGitHub?.org}
                  initialRepo={prefilledGitHub?.repo}
                  defaultOpen={false}
                />
              )}

              {/* Additional Settings (Ref, Repo Path, Local Path) */}
              <CollapsibleToggle
                expanded={showAdditionalSettings}
                onToggle={() => setShowAdditionalSettings(prev => !prev)}
                label="Additional Settings"
                disabled={isFormDisabled}
              >
                <div className="space-y-3 mt-3">
                  {/* Ref (branch/tag) */}
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
                      Ref <span className="font-normal text-muted-foreground">(optional)</span>
                      <InfoTooltip>
                        The branch or tag to clone. Defaults to the repository&apos;s default branch if not specified.
                        {tokenChecked && hasGitHubToken && (
                          <>
                            <br /><br /><strong>Tip:</strong> Use the GitHub browser above to browse branches and tags.
                          </>
                        )}
                      </InfoTooltip>
                    </label>
                    <input
                      type="text"
                      value={ref}
                      onChange={(e) => setRef(e.target.value)}
                      placeholder="Defaults to default branch"
                      disabled={isFormDisabled}
                      className="w-full px-3 py-2 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  {/* Repo Path (sparse checkout) */}
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
                      Repo Path <span className="font-normal text-muted-foreground">(optional)</span>
                      <InfoTooltip>
                        Clone only a specific subdirectory of the repository using sparse checkout. For example, <code>modules/vpc</code> would clone only that path instead of the entire repo.
                      </InfoTooltip>
                    </label>
                    <input
                      type="text"
                      value={repoPath}
                      onChange={(e) => setRepoPath(e.target.value)}
                      placeholder="e.g., modules/vpc"
                      disabled={isFormDisabled}
                      className="w-full px-3 py-2 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  {/* Local Path (destination) */}
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
                      Local Path <span className="font-normal text-muted-foreground">(optional)</span>
                      <InfoTooltip>
                        The directory where the cloned files will be saved, relative to the current working directory. Defaults to the repository name if not specified.
                      </InfoTooltip>
                    </label>
                    <input
                      type="text"
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      placeholder="Defaults to repo name"
                      disabled={isFormDisabled}
                      className="w-full px-3 py-2 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"
                    />
                    {pathPreview && (
                      <div className="mt-1.5 text-xs text-muted-foreground space-y-0.5">
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">Relative:</span>
                          <code className="bg-muted px-1 py-0.5 rounded font-mono text-muted-foreground">{pathPreview.relative}</code>
                          <button
                            onClick={() => handleCopyPath('relative', pathPreview.relative)}
                            className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            {copiedPathKey === 'relative' ? (
                              <Check className="size-3 text-success" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                          </button>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">Absolute:</span>
                          <code className="bg-muted px-1 py-0.5 rounded font-mono text-muted-foreground">{pathPreview.absolute}</code>
                          <button
                            onClick={() => handleCopyPath('absolute', pathPreview.absolute)}
                            className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            {copiedPathKey === 'absolute' ? (
                              <Check className="size-3 text-success" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </CollapsibleToggle>

              {/* Error message */}
              {errorMessage && cloneStatus === 'fail' && (
                <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
                  <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-destructive m-0">Clone failed</p>
                    <p className="text-xs text-destructive m-0 mt-0.5 font-mono">{errorMessage}</p>
                  </div>
                </div>
              )}

              {/* Overwrite confirmation */}
              {showOverwriteConfirm && (
                <div className="p-3 bg-warning-muted border border-warning/30 rounded-md flex items-start gap-2">
                  <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-warning-foreground m-0">Local path already exists</p>
                    <p className="text-xs text-warning-foreground m-0 mt-0.5">
                      The local path{pathPreview?.relative ? <> (<code className="text-warning-foreground">{pathPreview.relative}</code>)</> : ''} is not empty.
                      Delete it and continue with git clone? Any changes you&apos;ve made to files in this directory will be lost.
                      {pathPreview?.absolute && <> See <strong>Additional Settings</strong> above for the full path.</>}
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
                      className="text-destructive hover:text-destructive hover:bg-destructive-muted"
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

      {/* View Outputs - below logs */}
      {cloneStatus === 'success' && (
        <div className="mt-4 space-y-2">
          <ViewOutputs
            outputs={registeredOutputs}
            autoOpen={false}
          />
        </div>
      )}
    </div>
  )
}

/**
 * GitClone entry point. Branches on instruction mode before any clone hooks run:
 * in instruction mode it renders a copyable `git clone` command (no clone);
 * otherwise the interactive clone UI. Branching here keeps `useGitClone` (and
 * its session/token IPC) out of the instruction path.
 */
function GitClone(props: GitCloneProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <GitCloneInstruction {...props} />
  }
  return <GitCloneInteractive {...props} />
}

// Set displayName for React DevTools and component detection
GitClone.displayName = 'GitClone';

export default GitClone;
