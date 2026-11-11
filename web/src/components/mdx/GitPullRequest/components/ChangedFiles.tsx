import { ChangedFilesView } from "@/components/artifacts/workspace/ChangedFilesView"
import type { GitFileChangesContextType } from "@/contexts/WorkspaceGitDataContext.types"

/** The clone's changes, each file marked A, M or D, opening to its diff. */
export function ChangedFiles({ changes }: { changes: GitFileChangesContextType }) {
  return (
    <div
      className="mt-2 h-80 overflow-hidden rounded-md border border-border bg-card"
      data-testid="pr-changed-files"
    >
      <ChangedFilesView
        changes={changes.changes}
        tooManyChanges={changes.tooManyChanges}
        totalChanges={changes.totalChanges}
        isLoading={changes.isLoading}
        onLoadDiff={changes.fetchFileDiff}
        letters
      />
    </div>
  )
}
