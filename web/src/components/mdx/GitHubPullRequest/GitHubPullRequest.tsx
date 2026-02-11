import { GitPullRequest, CheckCircle, XCircle, Loader2, AlertTriangle } from "lucide-react"
import { useState, useEffect, useMemo, useCallback } from "react"
import { ViewLogs, ViewOutputs, InlineMarkdown, BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useRunbookContext } from "@/contexts/useRunbook"
import { normalizeBlockId } from "@/lib/utils"
import { useGitHubPullRequest } from "./hooks/useGitHubPullRequest"
import { PRForm } from "./components/PRForm"
import { PRResultDisplay } from "./components/PRResult"
import type { GitHubPullRequestProps, PRBlockStatus } from "./types"

/** Resolve template expressions like {{ ._blocks.X.outputs.Y }} */
function resolveTemplateString(template: string, blockOutputs: Record<string, { values: Record<string, string> }>): string {
  return template.replace(/\{\{\s*\._blocks\.(\w+)\.outputs\.(\w+)\s*\}\}/g, (_match, blockId, outputName) => {
    const normalizedId = normalizeBlockId(blockId)
    const value = blockOutputs[normalizedId]?.values?.[outputName]
    return value ?? _match // Leave unresolved patterns as-is
  })
}

function GitHubPullRequest({
  id,
  title = "Create Pull Request",
  description = "Open a pull request with your changes",
  prefilledPullRequestTitle = '',
  prefilledPullRequestDescription = '',
  prefilledPullRequestLabels = [],
  prefilledBranchName = '',
  githubAuthId,
}: GitHubPullRequestProps) {
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitHubPullRequest')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Git worktree context
  const { activeWorkTree } = useGitWorkTree()

  // Runbook context for template resolution
  const { blockOutputs: allOutputs } = useRunbookContext()

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
    pushError,
    labels,
    labelsLoading,
    githubAuthMet,
    sessionReady,
    createPullRequest,
    pushChanges,
    fetchLabels,
    cancel,
    reset,
  } = useGitHubPullRequest({ id, githubAuthId })

  // Resolve prefilled values with template expressions
  const resolvedTitle = useMemo(() =>
    prefilledPullRequestTitle ? resolveTemplateString(prefilledPullRequestTitle, allOutputs) : '',
    [prefilledPullRequestTitle, allOutputs]
  )
  const resolvedDescription = useMemo(() =>
    prefilledPullRequestDescription ? resolveTemplateString(prefilledPullRequestDescription, allOutputs) : '',
    [prefilledPullRequestDescription, allOutputs]
  )
  const resolvedBranchName = useMemo(() =>
    prefilledBranchName ? resolveTemplateString(prefilledBranchName, allOutputs) : '',
    [prefilledBranchName, allOutputs]
  )

  // Form state
  const defaultBranch = `runbook/${Math.floor(Date.now() / 1000)}`
  const [prTitle, setPRTitle] = useState(resolvedTitle)
  const [prDescription, setPRDescription] = useState(resolvedDescription)
  const [branchName, setBranchName] = useState(resolvedBranchName || defaultBranch)
  const [commitMessage, setCommitMessage] = useState("Changes from runbook")
  const [selectedLabels, setSelectedLabels] = useState<string[]>(prefilledPullRequestLabels)

  // Track if user has manually edited each field
  const [userEditedTitle, setUserEditedTitle] = useState(false)
  const [userEditedDescription, setUserEditedDescription] = useState(false)
  const [userEditedBranch, setUserEditedBranch] = useState(false)

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

  // Determine effective status (override pending → ready when deps met)
  const effectiveStatus: PRBlockStatus = useMemo(() => {
    if (status === 'pending' && githubAuthMet && activeWorkTree && sessionReady) {
      return 'ready'
    }
    return status
  }, [status, githubAuthMet, activeWorkTree, sessionReady])

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
      commitMessage: commitMessage.trim() || "Changes from runbook",
      localPath: activeWorkTree.localPath,
      repoUrl: activeWorkTree.repoUrl,
    })
  }, [activeWorkTree, prTitle, prDescription, selectedLabels, branchName, commitMessage, createPullRequest])

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
    setCommitMessage("Changes from runbook")
    setSelectedLabels(prefilledPullRequestLabels)
    setUserEditedTitle(false)
    setUserEditedDescription(false)
    setUserEditedBranch(false)
  }, [reset, resolvedTitle, resolvedDescription, prefilledPullRequestLabels])

  // Status-driven styling
  const statusConfig: Record<string, { bg: string; icon: typeof GitPullRequest; iconColor: string }> = {
    success:  { bg: 'bg-green-50 border-green-200', icon: CheckCircle,    iconColor: 'text-green-600' },
    fail:     { bg: 'bg-red-50 border-red-200',     icon: XCircle,        iconColor: 'text-red-600' },
    creating: { bg: 'bg-blue-50 border-blue-200',    icon: Loader2,        iconColor: 'text-blue-600' },
    pushing:  { bg: 'bg-blue-50 border-blue-200',    icon: Loader2,        iconColor: 'text-blue-600' },
    pending:  { bg: 'bg-gray-100 border-gray-200',   icon: GitPullRequest, iconColor: 'text-gray-500' },
    ready:    { bg: 'bg-gray-100 border-gray-200',   icon: GitPullRequest, iconColor: 'text-gray-500' },
  }

  const { bg: statusClasses, icon: IconComponent, iconColor: iconClasses } = statusConfig[effectiveStatus] ?? statusConfig.pending
  const isSpinning = effectiveStatus === 'creating' || effectiveStatus === 'pushing'
  const isFormDisabled = !githubAuthMet || !activeWorkTree

  // Block outputs for ViewOutputs
  const outputValues = useMemo(() => {
    if (!prResult) return null
    return {
      PR_ID: String(prResult.prNumber),
      PR_URL: prResult.prUrl,
    }
  }, [prResult])

  // If configuration error, don't render
  if (isDuplicate || isNormalizedCollision) {
    return null
  }

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Main container with left icon column */}
      <div className="flex @container">
        <div className="border-r border-gray-300 pr-2 mr-4 flex flex-col items-center">
          <IconComponent className={`size-6 ${iconClasses} ${isSpinning ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1 space-y-2">
          {/* Title and description */}
          <div className="text-md font-bold text-gray-700">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          <div className="text-md text-gray-600 mb-3">
            <InlineMarkdown>{description}</InlineMarkdown>
          </div>

          {/* Dependency warnings */}
          {!githubAuthMet && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800 m-0">Waiting for GitHub authentication</p>
                <p className="text-xs text-amber-600 m-0 mt-0.5">
                  Complete the &apos;{githubAuthId}&apos; GitHubAuth block above.
                </p>
              </div>
            </div>
          )}

          {!activeWorkTree && githubAuthMet && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2">
              <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800 m-0">No repository available</p>
                <p className="text-xs text-amber-600 m-0 mt-0.5">
                  Clone a repository using a GitClone block first.
                </p>
              </div>
            </div>
          )}

          {/* Error message */}
          {errorMessage && effectiveStatus === 'fail' && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
              <XCircle className="size-4 text-red-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-800 m-0">Pull request creation failed</p>
                <p className="text-xs text-red-600 m-0 mt-0.5 font-mono">{errorMessage}</p>
              </div>
            </div>
          )}

          {/* Success state */}
          {(effectiveStatus === 'success' || effectiveStatus === 'pushing') && prResult ? (
            <PRResultDisplay
              result={prResult}
              status={effectiveStatus}
              pushError={pushError}
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
              setCommitMessage={setCommitMessage}
              selectedLabels={selectedLabels}
              setSelectedLabels={setSelectedLabels}
              availableLabels={labels}
              labelsLoading={labelsLoading}
              status={effectiveStatus}
              disabled={isFormDisabled}
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

GitHubPullRequest.displayName = 'GitHubPullRequest'

export default GitHubPullRequest
