import { GitPullRequest, CheckCircle, XCircle, Loader2, AlertTriangle, Trash2 } from "lucide-react"
import { useState, useEffect, useMemo, useCallback } from "react"
import { ViewLogs, ViewOutputs, InlineMarkdown, BlockIdLabel, UnmetDependenciesWarning } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useRunbookContext, useTemplateContext, useAllOutputs } from "@/contexts/useRunbook"
import { resolveTemplateReferences, computeUnmetInputDependencies, computeUnmetOutputDependencies, filterUnmetOutputDeps } from "@/lib/templateUtils"
import { extractTemplateDependenciesFromString, splitDependencies } from "@/lib/extractTemplateDependencies"
import { GitHubLogo } from "@/components/mdx/GitHubAuth/components/GitHubLogo"
import { useGitFileChanges } from "@/hooks/useGitFileChanges"
import { useGitHubPullRequest } from "./hooks/useGitHubPullRequest"
import { PRForm } from "./components/PRForm"
import { PRResultDisplay } from "./components/PRResult"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { GitHubPullRequestInstruction } from "./GitHubPullRequestInstruction"
import type { AppError } from "@/types/error"
import type { GitHubPullRequestProps, PRBlockStatus } from "./types"

const STATUS_CONFIG: Record<string, { bg: string; icon: typeof GitPullRequest; iconColor: string }> = {
  success:  { bg: 'bg-success-muted border-success/30', icon: CheckCircle,    iconColor: 'text-success' },
  fail:     { bg: 'bg-destructive-muted border-destructive/30',     icon: XCircle,        iconColor: 'text-destructive' },
  creating: { bg: 'bg-info-muted border-info/40',    icon: Loader2,        iconColor: 'text-info' },
  pushing:  { bg: 'bg-info-muted border-info/40',    icon: Loader2,        iconColor: 'text-info' },
  pending:  { bg: 'bg-muted border-border',   icon: GitPullRequest, iconColor: 'text-muted-foreground' },
  ready:    { bg: 'bg-muted border-border',   icon: GitPullRequest, iconColor: 'text-muted-foreground' },
}

/** Resolve template expressions and process escape sequences (\n → newline). */
function resolveAndUnescape(template: string, ctx: import('@/lib/templateUtils').TemplateContext): string {
  return resolveTemplateReferences(template, ctx).replace(/\\n/g, '\n')
}

function GitHubPullRequestInteractive({
  id,
  title = "Create Pull Request",
  description = "Open a pull request with your changes",
  prefilledPullRequestTitle = '',
  prefilledPullRequestDescription = '',
  prefilledPullRequestLabels = [],
  prefilledBranchName = '',
  inputsId,
  githubAuthId,
}: GitHubPullRequestProps) {
  // Validate required props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <GitHubPullRequest> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitHubPullRequest')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Git worktree context
  const { activeWorkTree } = useGitWorkTree()

  // Runbook context for metadata; template context for resolving expressions
  const { runbookName } = useRunbookContext()
  const templateCtx = useTemplateContext(inputsId)
  const rawOutputs = useAllOutputs()

  // Extract and check template dependencies from props that support template expressions
  // Blocking dependencies (functional props): prefilledPullRequestTitle, prefilledPullRequestDescription, prefilledBranchName
  const blockingDeps = useMemo(() => [
    ...extractTemplateDependenciesFromString(prefilledPullRequestTitle ?? ''),
    ...extractTemplateDependenciesFromString(prefilledPullRequestDescription ?? ''),
    ...extractTemplateDependenciesFromString(prefilledBranchName ?? ''),
  ], [prefilledPullRequestTitle, prefilledPullRequestDescription, prefilledBranchName])

  // Non-blocking dependencies (display props): title, description
  const nonBlockingDeps = useMemo(() => [
    ...extractTemplateDependenciesFromString(title ?? ''),
    ...extractTemplateDependenciesFromString(description ?? ''),
  ], [title, description])

  // Combine all dependencies for resolution context
  const allDeps = useMemo(() => [...blockingDeps, ...nonBlockingDeps], [blockingDeps, nonBlockingDeps])
  const { inputs: allInputDeps, outputs: allOutputDeps } = useMemo(() => splitDependencies(allDeps), [allDeps])

  const allUnmetInputDeps = useMemo(
    () => computeUnmetInputDependencies(allInputDeps, templateCtx.inputs),
    [allInputDeps, templateCtx.inputs]
  )

  const allUnmetOutputDeps = useMemo(
    () => computeUnmetOutputDependencies(allOutputDeps, rawOutputs),
    [allOutputDeps, rawOutputs]
  )

  // Compute unmet dependencies for BLOCKING props only
  const { unmetInputDeps, unmetOutputDeps } = useMemo(() => {
    const { inputs: blockingInputDeps, outputs: blockingOutputDeps } = splitDependencies(blockingDeps)
    return {
      unmetInputDeps: allUnmetInputDeps.filter(dep => blockingInputDeps.includes(dep)),
      unmetOutputDeps: filterUnmetOutputDeps(allUnmetOutputDeps, blockingOutputDeps)
    }
  }, [blockingDeps, allUnmetInputDeps, allUnmetOutputDeps])

  const hasAllBlockingDependencies = unmetInputDeps.length === 0 && unmetOutputDeps.length === 0

  // Track render
  useEffect(() => {
    trackBlockRender('GitHubPullRequest')
  }, [id, trackBlockRender])

  // Core hook
  const {
    status,
    logs,
    prResult,
    errorMessage,
    errorCode,
    conflictBranchName,
    pushError,
    labels,
    labelsLoading,
    githubAuthMet,
    createPullRequest,
    pushChanges,
    deleteBranch,
    fetchLabels,
    cancel,
    reset,
  } = useGitHubPullRequest({ id, githubAuthId })

  // Workspace changes for diff summary
  const { changes: workspaceChanges } = useGitFileChanges()

  const changeSummary = useMemo(() => {
    if (!workspaceChanges || workspaceChanges.length === 0) return null
    return {
      fileCount: workspaceChanges.length,
      additions: workspaceChanges.reduce((sum, c) => sum + c.additions, 0),
      deletions: workspaceChanges.reduce((sum, c) => sum + c.deletions, 0),
    }
  }, [workspaceChanges])

  // Resolve prefilled values with template expressions ({{ .inputs.X }} and {{ .outputs.X.Y }})
  const resolvedTitle = useMemo(() =>
    prefilledPullRequestTitle ? resolveAndUnescape(prefilledPullRequestTitle, templateCtx) : '',
    [prefilledPullRequestTitle, templateCtx]
  )
  const resolvedDescription = useMemo(() =>
    prefilledPullRequestDescription ? resolveAndUnescape(prefilledPullRequestDescription, templateCtx) : '',
    [prefilledPullRequestDescription, templateCtx]
  )
  const resolvedBranchName = useMemo(() =>
    prefilledBranchName ? resolveAndUnescape(prefilledBranchName, templateCtx) : '',
    [prefilledBranchName, templateCtx]
  )

  // Resolve display props (title and description support template expressions too)
  const resolvedDisplayTitle = useMemo(() =>
    title ? resolveTemplateReferences(title, templateCtx) : title,
    [title, templateCtx]
  )
  const resolvedDisplayDescription = useMemo(() =>
    description ? resolveTemplateReferences(description, templateCtx) : description,
    [description, templateCtx]
  )

  // Default commit message includes the runbook name when available
  const defaultCommitMessage = runbookName
    ? `Changes from runbook "${runbookName}"`
    : "Changes from runbook"

  // Form state
  const [prTitle, setPRTitle] = useState(resolvedTitle)
  const [prDescription, setPRDescription] = useState(resolvedDescription)
  const [branchName, setBranchName] = useState(() => resolvedBranchName || `runbook/${Math.floor(Date.now() / 1000)}`)
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage)
  const [selectedLabels, setSelectedLabels] = useState<string[]>(prefilledPullRequestLabels)

  // Track if user has manually edited each field
  const [userEditedTitle, setUserEditedTitle] = useState(false)
  const [userEditedDescription, setUserEditedDescription] = useState(false)
  const [userEditedBranch, setUserEditedBranch] = useState(false)
  const [userEditedCommitMessage, setUserEditedCommitMessage] = useState(false)

  // Update form state when resolved values change (unless user has edited)
  useEffect(() => {
    if (!userEditedTitle && resolvedTitle) {
      setPRTitle(resolvedTitle)
    }
  }, [resolvedTitle, userEditedTitle])

  useEffect(() => {
    if (!userEditedDescription && resolvedDescription) {
      setPRDescription(resolvedDescription)
    }
  }, [resolvedDescription, userEditedDescription])

  useEffect(() => {
    if (!userEditedBranch && resolvedBranchName) {
      setBranchName(resolvedBranchName)
    }
  }, [resolvedBranchName, userEditedBranch])

  useEffect(() => {
    if (!userEditedCommitMessage) {
      setCommitMessage(defaultCommitMessage)
    }
  }, [defaultCommitMessage, userEditedCommitMessage])

  // Determine effective status (override pending → ready when deps met)
  const effectiveStatus: PRBlockStatus = useMemo(() => {
    if (status === 'pending' && githubAuthMet && activeWorkTree) {
      return 'ready'
    }
    return status
  }, [status, githubAuthMet, activeWorkTree])

  // Fetch labels when ready
  useEffect(() => {
    if (effectiveStatus === 'ready' && activeWorkTree?.gitInfo?.repoOwner && activeWorkTree?.gitInfo?.repoName) {
      fetchLabels(activeWorkTree.gitInfo.repoOwner, activeWorkTree.gitInfo.repoName)
    }
  }, [effectiveStatus, activeWorkTree?.gitInfo?.repoOwner, activeWorkTree?.gitInfo?.repoName, fetchLabels])

  // Report configuration errors
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'GitHubPullRequest',
        severity: 'error',
        message: `Duplicate GitHubPullRequest block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: 'GitHubPullRequest',
        severity: 'error',
        message: `GitHubPullRequest ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  // Handle create PR
  const handleCreatePR = useCallback(() => {
    if (!activeWorkTree) return
    createPullRequest({
      title: prTitle.trim(),
      description: prDescription,
      labels: selectedLabels,
      branchName: branchName.trim(),
      commitMessage: commitMessage.trim() || defaultCommitMessage,
      localPath: activeWorkTree.localPath,
      repoUrl: activeWorkTree.repoUrl,
    })
  }, [activeWorkTree, prTitle, prDescription, selectedLabels, branchName, commitMessage, defaultCommitMessage, createPullRequest])

  // Handle push
  const handlePush = useCallback(() => {
    if (!activeWorkTree || !prResult) return
    pushChanges(activeWorkTree.localPath, prResult.branchName)
  }, [activeWorkTree, prResult, pushChanges])

  // Handle create another
  const handleCreateAnother = useCallback(() => {
    reset()
    setPRTitle(resolvedTitle)
    setPRDescription(resolvedDescription)
    setBranchName(`runbook/${Math.floor(Date.now() / 1000)}`)
    setCommitMessage(defaultCommitMessage)
    setSelectedLabels(prefilledPullRequestLabels)
    setUserEditedTitle(false)
    setUserEditedDescription(false)
    setUserEditedBranch(false)
    setUserEditedCommitMessage(false)
  }, [reset, resolvedTitle, resolvedDescription, prefilledPullRequestLabels, defaultCommitMessage])

  // Delete conflicting branch handler
  const [deletingBranch, setDeletingBranch] = useState(false)
  const handleDeleteBranch = useCallback(async () => {
    if (!activeWorkTree || !conflictBranchName) return
    setDeletingBranch(true)
    await deleteBranch(activeWorkTree.localPath, conflictBranchName)
    setDeletingBranch(false)
  }, [activeWorkTree, conflictBranchName, deleteBranch])

  const { bg: statusClasses, icon: IconComponent, iconColor: iconClasses } = STATUS_CONFIG[effectiveStatus] ?? STATUS_CONFIG.pending
  const isSpinning = effectiveStatus === 'creating' || effectiveStatus === 'pushing'
  const isFormDisabled = !githubAuthMet || !activeWorkTree || !hasAllBlockingDependencies

  // Block outputs for ViewOutputs
  const outputValues = useMemo(() => {
    if (!prResult) return null
    return {
      PR_ID: String(prResult.prNumber),
      PR_URL: prResult.prUrl,
    }
  }, [prResult])

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // If configuration error, don't render
  if (isDuplicate || isNormalizedCollision) {
    return null
  }

  return (
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Main container with left icon column */}
      <div className="flex @container">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <IconComponent className={`size-6 ${iconClasses} ${isSpinning ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1 space-y-2">
          {/* Title and description */}
          <div className="flex items-center gap-1 text-md font-bold text-foreground">
            <GitHubLogo className="size-6 text-foreground" />
            <InlineMarkdown>{resolvedDisplayTitle}</InlineMarkdown>
          </div>
          <div className="text-md text-muted-foreground mb-3">
            <InlineMarkdown>{resolvedDisplayDescription}</InlineMarkdown>
          </div>

          {/* Dependency warnings */}
          {!githubAuthMet && (
            <div className="mb-4 p-3 bg-warning-muted border border-warning/30 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-warning-foreground m-0">Waiting for GitHub authentication</p>
                <p className="text-xs text-warning-foreground m-0 mt-0.5">
                  Complete the &apos;{githubAuthId}&apos; GitHubAuth block above.
                </p>
              </div>
            </div>
          )}

          {!activeWorkTree && githubAuthMet && (
            <div className="mb-4 p-3 bg-warning-muted border border-warning/30 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-warning-foreground m-0">No repository available</p>
                <p className="text-xs text-warning-foreground m-0 mt-0.5">
                  Clone a repository using a GitClone block first.
                </p>
              </div>
            </div>
          )}

          {/* Template dependency warnings (blocking only) */}
          {!hasAllBlockingDependencies && (
            <div className="mb-4">
              <UnmetDependenciesWarning
                blockType="pull request"
                unmetInputDeps={unmetInputDeps}
                unmetOutputDeps={unmetOutputDeps}
              />
            </div>
          )}

          {/* Error message */}
          {errorMessage && effectiveStatus === 'fail' && (
            <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
              <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive m-0">Pull request creation failed</p>
                <p className="text-xs text-destructive m-0 mt-0.5 font-mono">{errorMessage}</p>
                {errorCode === 'branch_exists' && conflictBranchName && (
                  <button
                    type="button"
                    onClick={handleDeleteBranch}
                    disabled={deletingBranch}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-destructive bg-destructive-muted hover:bg-destructive-muted/80 border border-destructive/30 rounded-md cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="size-3" />
                    {deletingBranch ? 'Deleting...' : `Delete branch "${conflictBranchName}" and retry`}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Success state */}
          {(effectiveStatus === 'success' || effectiveStatus === 'pushing') && prResult ? (
            <PRResultDisplay
              result={prResult}
              status={effectiveStatus}
              pushError={pushError}
              changeSummary={changeSummary}
              onPush={handlePush}
              onCreateAnother={handleCreateAnother}
            />
          ) : (
            /* Form state */
            <PRForm
              prTitle={prTitle}
              setPRTitle={(v) => { setPRTitle(v); setUserEditedTitle(true) }}
              prDescription={prDescription}
              setPRDescription={(v) => { setPRDescription(v); setUserEditedDescription(true) }}
              branchName={branchName}
              setBranchName={(v) => { setBranchName(v); setUserEditedBranch(true) }}
              commitMessage={commitMessage}
              setCommitMessage={(v) => { setCommitMessage(v); setUserEditedCommitMessage(true) }}
              defaultCommitMessage={defaultCommitMessage}
              selectedLabels={selectedLabels}
              setSelectedLabels={setSelectedLabels}
              availableLabels={labels}
              labelsLoading={labelsLoading}
              status={effectiveStatus}
              disabled={isFormDisabled}
              changeSummary={changeSummary}
              onSubmit={handleCreatePR}
              onCancel={cancel}
            />
          )}
        </div>
      </div>

      {/* View Logs */}
      {logs.length > 0 && (
        <div className="mt-4 space-y-2">
          <ViewLogs
            logs={logs}
            status={isSpinning ? 'running' : effectiveStatus === 'success' ? 'success' : effectiveStatus === 'fail' ? 'fail' : 'pending'}
            autoOpen={isSpinning}
            blockId={id}
          />
        </div>
      )}

      {/* View Outputs */}
      {outputValues && (
        <div className="mt-2">
          <ViewOutputs
            outputs={outputValues}
            autoOpen={effectiveStatus === 'success'}
          />
        </div>
      )}
    </div>
  )
}

/**
 * GitHubPullRequest entry point. Branches on instruction mode before any PR
 * hooks run: in instruction mode it renders a copyable `gh pr create` command
 * (no push, no PR); otherwise the interactive PR UI. Branching here keeps
 * `useGitHubPullRequest` IPC out of the instruction path.
 */
function GitHubPullRequest(props: GitHubPullRequestProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <GitHubPullRequestInstruction {...props} />
  }
  return <GitHubPullRequestInteractive {...props} />
}

GitHubPullRequest.displayName = 'GitHubPullRequest'

export default GitHubPullRequest
