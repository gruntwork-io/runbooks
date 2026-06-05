import { CheckCircle, XCircle, Loader2, AlertTriangle, Trash2, GitPullRequest as GitPullRequestIcon } from "lucide-react"
import { useState, useEffect, useMemo, useCallback } from "react"
import { ViewLogs, ViewOutputs, InlineMarkdown, BlockIdLabel, UnmetDependenciesWarning } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import type { BlockComponentType } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useRunbookContext, useTemplateContext, useAllOutputs } from "@/contexts/useRunbook"
import { resolveTemplateReferences, computeUnmetInputDependencies, computeUnmetOutputDependencies, filterUnmetOutputDeps } from "@/lib/templateUtils"
import { extractTemplateDependenciesFromString, splitDependencies } from "@/lib/extractTemplateDependencies"
import { deriveProviderFromAuth, deriveProviderFromRepoUrl, hostFromRepoUrl } from "@/components/mdx/_shared/lib/gitProvider"
import { useGitFileChanges } from "@/hooks/useGitFileChanges"
import { PR_PROVIDERS } from "./providers"
import { useGitPullRequest } from "./hooks/useGitPullRequest"
import { PRForm } from "./components/PRForm"
import { PRResultDisplay } from "./components/PRResult"
import { WrongProviderError } from "./components/WrongProviderError"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { GitPullRequestInstruction } from "./GitPullRequestInstruction"
import type { AppError } from "@/types/error"
import type { GitPullRequestProps, PRBlockStatus } from "./types"

type GitPullRequestInternalProps = GitPullRequestProps & { __registryType?: BlockComponentType }

const STATUS_CONFIG: Record<string, { bg: string; icon: typeof GitPullRequestIcon; iconColor: string }> = {
  success:  { bg: 'bg-success-muted border-success/30', icon: CheckCircle,    iconColor: 'text-success' },
  fail:     { bg: 'bg-destructive-muted border-destructive/30',     icon: XCircle,        iconColor: 'text-destructive' },
  creating: { bg: 'bg-info-muted border-info/40',    icon: Loader2,        iconColor: 'text-info' },
  pushing:  { bg: 'bg-info-muted border-info/40',    icon: Loader2,        iconColor: 'text-info' },
  pending:  { bg: 'bg-muted border-border',   icon: GitPullRequestIcon, iconColor: 'text-muted-foreground' },
  ready:    { bg: 'bg-muted border-border',   icon: GitPullRequestIcon, iconColor: 'text-muted-foreground' },
}

/** Resolve template expressions and process escape sequences (\n → newline). */
function resolveAndUnescape(template: string, ctx: import('@/lib/templateUtils').TemplateContext): string {
  return resolveTemplateReferences(template, ctx).replace(/\\n/g, '\n')
}

function GitPullRequestInteractive({
  id,
  title,
  description,
  prefilledPullRequestTitle = '',
  prefilledPullRequestDescription = '',
  prefilledPullRequestLabels = [],
  prefilledBranchName = '',
  inputsId,
  githubAuthId,
  gitAuthId,
  provider: propProvider,
  __registryType = 'GitPullRequest',
}: GitPullRequestInternalProps) {
  // Validate required props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: `The <${__registryType}> component requires a non-empty 'id' prop.`,
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id, __registryType])

  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, __registryType)

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

  // Resolve the effective provider. A locked wrapper passes `provider`; otherwise
  // derive it from the linked auth block (its GIT_PROVIDER output), then from the
  // cloned repo's host as a last resort, defaulting to github. `cfg` drives every
  // provider-specific channel, token var, logo, and label.
  const authId = gitAuthId ?? githubAuthId
  const authDerivedProvider = deriveProviderFromAuth(authId, rawOutputs)
  const repoUrlDerivedProvider = deriveProviderFromRepoUrl(activeWorkTree?.gitInfo?.repoUrl)
  const effectiveProvider = propProvider ?? authDerivedProvider ?? repoUrlDerivedProvider ?? 'github'
  const cfg = PR_PROVIDERS[effectiveProvider]

  // Provider-aware display defaults
  const titleText = title ?? cfg.defaultTitle
  const descriptionText = description ?? `Open a ${cfg.noun.lower} with your changes`

  // Extract and check template dependencies from props that support template expressions
  // Blocking dependencies (functional props): prefilledPullRequestTitle, prefilledPullRequestDescription, prefilledBranchName
  const blockingDeps = useMemo(() => [
    ...extractTemplateDependenciesFromString(prefilledPullRequestTitle ?? ''),
    ...extractTemplateDependenciesFromString(prefilledPullRequestDescription ?? ''),
    ...extractTemplateDependenciesFromString(prefilledBranchName ?? ''),
  ], [prefilledPullRequestTitle, prefilledPullRequestDescription, prefilledBranchName])

  // Non-blocking dependencies (display props): title, description
  const nonBlockingDeps = useMemo(() => [
    ...extractTemplateDependenciesFromString(titleText ?? ''),
    ...extractTemplateDependenciesFromString(descriptionText ?? ''),
  ], [titleText, descriptionText])

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
    trackBlockRender(__registryType)
  }, [id, trackBlockRender, __registryType])

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
    authMet,
    wrongProvider,
    createPullRequest,
    pushChanges,
    deleteBranch,
    fetchLabels,
    cancel,
    reset,
  } = useGitPullRequest({ id, cfg, authId, authDerivedProvider })

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
    titleText ? resolveTemplateReferences(titleText, templateCtx) : titleText,
    [titleText, templateCtx]
  )
  const resolvedDisplayDescription = useMemo(() =>
    descriptionText ? resolveTemplateReferences(descriptionText, templateCtx) : descriptionText,
    [descriptionText, templateCtx]
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
    if (status === 'pending' && authMet && activeWorkTree && !wrongProvider) {
      return 'ready'
    }
    return status
  }, [status, authMet, activeWorkTree, wrongProvider])

  // Fetch labels when ready. Pass the repo's host so a self-hosted GitLab's
  // labels are fetched from its own instance, not gitlab.com.
  useEffect(() => {
    if (effectiveStatus === 'ready' && activeWorkTree?.gitInfo?.repoOwner && activeWorkTree?.gitInfo?.repoName) {
      fetchLabels(
        activeWorkTree.gitInfo.repoOwner,
        activeWorkTree.gitInfo.repoName,
        hostFromRepoUrl(activeWorkTree?.gitInfo?.repoUrl),
      )
    }
  }, [effectiveStatus, activeWorkTree?.gitInfo?.repoOwner, activeWorkTree?.gitInfo?.repoName, activeWorkTree?.gitInfo?.repoUrl, fetchLabels])

  // Report configuration errors
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: __registryType,
        severity: 'error',
        message: `Duplicate ${__registryType} block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: __registryType,
        severity: 'error',
        message: `${__registryType} ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError, __registryType])

  // Handle create PR/MR
  const handleCreatePR = useCallback(() => {
    if (!activeWorkTree) return
    createPullRequest({
      owner: activeWorkTree.gitInfo.repoOwner,
      repo: activeWorkTree.gitInfo.repoName,
      // The ref the worktree was cloned at is the base/target branch.
      baseBranch: activeWorkTree.gitInfo.ref,
      headBranch: branchName.trim(),
      title: prTitle.trim(),
      body: prDescription,
      commitMessage: commitMessage.trim() || defaultCommitMessage,
      labels: selectedLabels,
      worktreePath: activeWorkTree.localPath,
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
  const isFormDisabled = wrongProvider || !authMet || !activeWorkTree || !hasAllBlockingDependencies

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
            <cfg.Logo className="size-6 text-foreground" />
            <InlineMarkdown>{resolvedDisplayTitle}</InlineMarkdown>
          </div>
          <div className="text-md text-muted-foreground mb-3">
            <InlineMarkdown>{resolvedDisplayDescription}</InlineMarkdown>
          </div>

          {/* Wrong-auth-block error (blocking, both providers) */}
          {wrongProvider && authDerivedProvider && (
            <WrongProviderError cfg={cfg} authDerivedProvider={authDerivedProvider} />
          )}

          {/* Dependency warnings */}
          {!wrongProvider && !authMet && (
            <div className="mb-4 p-3 bg-warning-muted border border-warning/30 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-warning-foreground m-0">Waiting for {cfg.label} authentication</p>
                <p className="text-xs text-warning-foreground m-0 mt-0.5">
                  Complete the &apos;{authId}&apos; {cfg.label} authentication block above.
                </p>
              </div>
            </div>
          )}

          {!wrongProvider && !activeWorkTree && authMet && (
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
                blockType={cfg.noun.lower}
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
                <p className="text-sm font-medium text-destructive m-0">{cfg.noun.singular} creation failed</p>
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
              noun={cfg.noun}
              refSymbol={cfg.refSymbol}
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
              noun={cfg.noun}
              providerLabel={cfg.label}
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
 * GitPullRequest entry point. Branches on instruction mode before any PR/MR
 * hooks run: in instruction mode it renders a copyable `gh pr create` /
 * `glab mr create` command (no push, no PR/MR); otherwise the interactive UI.
 * Branching here keeps `useGitPullRequest` IPC out of the instruction path.
 */
function GitPullRequest(props: GitPullRequestInternalProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <GitPullRequestInstruction {...props} />
  }
  return <GitPullRequestInteractive {...props} />
}

GitPullRequest.displayName = 'GitPullRequest'

export { GitPullRequest }
export default GitPullRequest
