import { useEffect } from "react"
import { XCircle, AlertTriangle, Loader2, GitFork } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { Button } from "@/components/ui/button"

import type { GitCloneProps } from "./types"
import { useGitClone } from "./hooks/useGitClone"
import { RepoSelector } from "./components/RepoSelector"
import { BranchSelector } from "./components/BranchSelector"
import { CloneSuccess } from "./components/CloneSuccess"

function getStatusClasses(status: string): string {
  switch (status) {
    case 'cloned':
      return 'bg-green-50 border-green-200'
    case 'failed':
      return 'bg-red-50 border-red-200'
    case 'cloning':
      return 'bg-blue-50 border-blue-200'
    default:
      return 'bg-gray-50 border-gray-200'
  }
}

function getStatusIconClasses(status: string): string {
  switch (status) {
    case 'cloned':
      return 'text-green-600'
    case 'failed':
      return 'text-red-600'
    case 'cloning':
      return 'text-blue-600'
    default:
      return 'text-gray-600'
  }
}

function GitClone({
  id,
  title = "Clone Repository",
  description,
  githubAuthId,
  repo,
  branch,
  allowRepoSelection,
  allowBranchSelection = true,
  workspacePath,
}: GitCloneProps) {
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitClone')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // All clone state and handlers from custom hook
  const clone = useGitClone({
    id,
    githubAuthId,
    repo,
    branch,
    allowRepoSelection,
    allowBranchSelection,
    workspacePath,
  })

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('GitClone')
  }, [trackBlockRender])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'GitClone',
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
                Another <code className="bg-red-100 px-1 rounded">{"<GitClone>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const statusClasses = getStatusClasses(clone.status)
  const iconClasses = getStatusIconClasses(clone.status)

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-gray-300 pr-3 mr-0 self-stretch">
          {clone.status === 'cloning' ? (
            <Loader2 className={`size-6 ${iconClasses} animate-spin`} />
          ) : (
            <GitFork className={`size-6 ${iconClasses}`} />
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
          {!clone.isGitHubAuthenticated && clone.githubAuthId && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                Waiting for GitHub authentication.
                <br />
                <span className="text-amber-700">
                  Complete the <code className="bg-amber-100 px-1 rounded">{clone.githubAuthId}</code> block first.
                </span>
              </div>
            </div>
          )}

          {/* Success state */}
          {clone.status === 'cloned' && clone.cloneResult && (
            <CloneSuccess result={clone.cloneResult} />
          )}

          {/* Error state */}
          {clone.status === 'failed' && clone.errorMessage && (
            <div className="mb-4 text-red-600 text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Clone failed:</strong> {clone.errorMessage}
              </div>
            </div>
          )}

          {/* Clone UI (only show when not cloned and auth is complete) */}
          {clone.status !== 'cloned' && clone.isGitHubAuthenticated && (
            <div className="space-y-4">
              {/* Repo selector */}
              {clone.allowRepoSelection ? (
                <RepoSelector
                  repos={clone.repos}
                  loading={clone.loadingRepos}
                  selectedRepo={clone.selectedRepo}
                  searchValue={clone.repoSearch}
                  setSearchValue={clone.setRepoSearch}
                  onRepoSelect={clone.handleRepoChange}
                  onRefresh={clone.loadRepos}
                  disabled={clone.status === 'cloning'}
                />
              ) : (
                <div className="text-sm">
                  <span className="text-gray-600">Repository:</span>{' '}
                  <span className="font-mono font-medium">{clone.selectedRepo}</span>
                </div>
              )}

              {/* Branch selector */}
              {clone.allowBranchSelection && clone.selectedRepo ? (
                <BranchSelector
                  branches={clone.branches}
                  loading={clone.loadingBranches}
                  selectedBranch={clone.selectedBranch}
                  searchValue={clone.branchSearch}
                  setSearchValue={clone.setBranchSearch}
                  onBranchSelect={clone.setSelectedBranch}
                  disabled={clone.status === 'cloning'}
                />
              ) : clone.selectedBranch ? (
                <div className="text-sm">
                  <span className="text-gray-600">Branch:</span>{' '}
                  <span className="font-mono font-medium">{clone.selectedBranch}</span>
                </div>
              ) : null}

              {/* Clone button */}
              <Button
                onClick={clone.handleClone}
                disabled={clone.status === 'cloning' || !clone.selectedRepo || !clone.selectedBranch}
                className="w-full"
              >
                {clone.status === 'cloning' ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    {clone.cloneProgress || 'Cloning...'}
                  </>
                ) : (
                  <>
                    <GitFork className="size-4 mr-2" />
                    Clone Repository
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

GitClone.displayName = 'GitClone'

export default GitClone
