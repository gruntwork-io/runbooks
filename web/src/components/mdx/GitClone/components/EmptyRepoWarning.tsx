import { useState } from "react"
import { AlertTriangle, GitBranch, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

interface EmptyRepoWarningProps {
  /** Branch the remote advertises as its default — the name to seed. */
  suggestedBranch: string
  status: 'idle' | 'running' | 'fail'
  error: string | null
  onCreateDefaultBranch: (branch: string) => void
}

/**
 * Shown when the repo behind this block has no commits at all.
 *
 * A repo in that state has no branch, so nothing downstream can open a pull
 * request against it — the API rejects the base branch as invalid, and only
 * after a runbook has already committed and pushed its work. The block holds
 * its outputs back until the repo has a default branch, and offers to create
 * one here.
 */
export function EmptyRepoWarning({
  suggestedBranch,
  status,
  error,
  onCreateDefaultBranch,
}: EmptyRepoWarningProps) {
  const [branch, setBranch] = useState(suggestedBranch)
  const isRunning = status === 'running'
  const trimmed = branch.trim()

  return (
    <div className="bg-warning-muted border border-warning/30 rounded-md p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="size-5 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-warning-foreground mb-2">
            This repository has no commits yet
          </h4>
          <p className="text-sm text-warning-foreground mb-3">
            An empty repository has no branch, so there is nothing for a pull request to
            target. Later steps are on hold until it has one — otherwise they would run to
            completion and fail only at the end, after committing and pushing their work.
          </p>
          <p className="text-sm text-warning-foreground mb-3">
            Creating the default branch here pushes a single empty commit. The branch a
            runbook opens later then shares an ancestor with it and reviews as a normal
            diff.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="empty-repo-branch" className="sr-only">
              Default branch name
            </label>
            <div className="flex items-center gap-1.5">
              <GitBranch className="size-4 text-warning-foreground flex-shrink-0" />
              <input
                id="empty-repo-branch"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                disabled={isRunning}
                className="w-40 px-2 py-1 text-sm font-mono border border-warning/30 rounded bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Button
              size="sm"
              disabled={isRunning || !trimmed}
              onClick={() => onCreateDefaultBranch(trimmed)}
              className="bg-warning hover:bg-warning/90 text-white"
            >
              {isRunning ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create default branch'
              )}
            </Button>
          </div>

          {error && (
            <p className="mt-3 text-sm text-destructive break-words">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
}
