import { useEffect, useState } from "react"
import { XCircle, AlertTriangle, Loader2, GitPullRequest as GitPullRequestIcon, Eye } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { Button } from "@/components/ui/button"

import type { GitHubPullRequestProps } from "./types"
import { useGitHubPullRequest } from "./hooks/useGitHubPullRequest"
import { PRForm } from "./components/PRForm"
import { PRSuccess } from "./components/PRSuccess"
import { ChangesPanel } from "@/components/git/ChangesPanel"
import { DiffModal } from "@/components/git/DiffModal"

function getStatusClasses(status: string): string {
  switch (status) {
    case 'created':
      return 'bg-green-50 border-green-200'
    case 'failed':
      return 'bg-red-50 border-red-200'
    case 'creating':
      return 'bg-blue-50 border-blue-200'
    default:
      return 'bg-gray-50 border-gray-200'
  }
}

function getStatusIconClasses(status: string): string {
  switch (status) {
    case 'created':
      return 'text-green-600'
    case 'failed':
      return 'text-red-600'
    case 'creating':
      return 'text-blue-600'
    default:
      return 'text-gray-600'
  }
}

function GitHubPullRequest({
  id,
  title = "Create Pull Request",
  description,
  githubAuthId,
  gitCloneId,
  defaultBranchName,
  defaultCommitMessage,
  defaultPrTitle,
  defaultPrBody,
  targetBranch,
  draft,
}: GitHubPullRequestProps) {
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitHubPullRequest')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // State for diff modal
  const [showDiffModal, setShowDiffModal] = useState(false)

  // All PR state and handlers from custom hook
  const pr = useGitHubPullRequest({
    id,
    githubAuthId,
    gitCloneId,
    defaultBranchName,
    defaultCommitMessage,
    defaultPrTitle,
    defaultPrBody,
    targetBranch,
    draft,
  })

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('GitHubPullRequest')
  }, [trackBlockRender])

  // Report configuration errors
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'GitHubPullRequest',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, reportError, clearError])

  // Early return for duplicate ID
  if (isDuplicate) {
    return (
      <div className="runbook-block relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong><br />
                The ID <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> collides with <code className="bg-red-100 px-1 rounded">{`"${collidingId}"`}</code>.
              </>
            ) : (
              <>
                <strong>Duplicate Component ID:</strong><br />
                Another <code className="bg-red-100 px-1 rounded">{"<GitHubPullRequest>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const statusClasses = getStatusClasses(pr.status)
  const iconClasses = getStatusIconClasses(pr.status)

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-gray-300 pr-3 mr-0 self-stretch">
          {pr.status === 'creating' ? (
            <Loader2 className={`size-6 ${iconClasses} animate-spin`} />
          ) : (
            <GitPullRequestIcon className={`size-6 ${iconClasses}`} />
          )}
        </div>

        <div className="flex-1">
          {/* Title */}
          <div className="flex items-center gap-3 mb-2">
            <div className="text-md font-bold text-gray-700">
              <InlineMarkdown>{title}</InlineMarkdown>
            </div>
          </div>

          {description && (
            <div className="text-md text-gray-600 mb-4">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}

          {/* Auth dependency warning */}
          {!pr.isGitHubAuthenticated && pr.githubAuthId && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                Waiting for GitHub authentication.
                <br />
                <span className="text-amber-700">
                  Complete the <code className="bg-amber-100 px-1 rounded">{pr.githubAuthId}</code> block first.
                </span>
              </div>
            </div>
          )}

          {/* Clone dependency warning */}
          {!pr.isCloneComplete && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                Waiting for repository to be cloned.
                <br />
                <span className="text-amber-700">
                  Complete the <code className="bg-amber-100 px-1 rounded">{pr.gitCloneId}</code> block first.
                </span>
              </div>
            </div>
          )}

          {/* Success state */}
          {pr.status === 'created' && pr.prResult && (
            <PRSuccess result={pr.prResult} />
          )}

          {/* Error state */}
          {pr.status === 'failed' && pr.errorMessage && (
            <div className="mb-4 text-red-600 text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Failed to create PR:</strong> {pr.errorMessage}
              </div>
            </div>
          )}

          {/* PR form (only show when ready and not created) */}
          {pr.status !== 'created' && pr.isGitHubAuthenticated && pr.isCloneComplete && (
            <>
              {/* Changed files summary */}
              {pr.changedFiles.length > 0 && (
                <div className="mb-4 bg-gray-50 border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-700">
                      {pr.changedFiles.length} file{pr.changedFiles.length !== 1 ? 's' : ''} changed
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowDiffModal(true)}
                    >
                      <Eye className="size-4 mr-1" />
                      Review Changes
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {pr.changedFiles.slice(0, 5).map(file => (
                      <span
                        key={file.path}
                        className="px-2 py-0.5 bg-white border rounded text-xs font-mono text-gray-600"
                      >
                        {file.path.split('/').pop()}
                      </span>
                    ))}
                    {pr.changedFiles.length > 5 && (
                      <span className="px-2 py-0.5 text-xs text-gray-500">
                        +{pr.changedFiles.length - 5} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* No changes warning */}
              {pr.changedFiles.length === 0 && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
                  No changes detected in the workspace. Make changes using other blocks before creating a PR.
                </div>
              )}

              <PRForm
                status={pr.status}
                branchName={pr.branchName}
                setBranchName={pr.setBranchName}
                commitMessage={pr.commitMessage}
                setCommitMessage={pr.setCommitMessage}
                prTitle={pr.prTitle}
                setPrTitle={pr.setPrTitle}
                prBody={pr.prBody}
                setPrBody={pr.setPrBody}
                isDraft={pr.isDraft}
                setIsDraft={pr.setIsDraft}
                onSubmit={pr.handleCreatePR}
                progressMessage={pr.progressMessage}
                changedFilesCount={pr.changedFiles.length}
              />
            </>
          )}
        </div>
      </div>

      {/* Diff modal */}
      {pr.workspaceInfo && (
        <DiffModal
          isOpen={showDiffModal}
          onClose={() => setShowDiffModal(false)}
          files={pr.changedFiles}
          workspacePath={pr.workspaceInfo.workspacePath}
        />
      )}
    </div>
  )
}

GitHubPullRequest.displayName = 'GitHubPullRequest'

export default GitHubPullRequest
