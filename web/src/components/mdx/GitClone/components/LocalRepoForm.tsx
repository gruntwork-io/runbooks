import { FolderGit2, FolderOpen, Loader2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InfoTooltip } from "@/components/mdx/GitPullRequest/components/InfoTooltip"
import type { LocalRepoInfo } from "../types"

export type LocalPreviewStatus = 'idle' | 'checking' | 'valid' | 'invalid'

interface LocalRepoFormProps {
  /** Current directory in the input (may be a subdirectory of the repo). */
  repoDir: string
  onRepoDirChange: (value: string) => void
  /** Opens the native folder picker. */
  onBrowse: () => void
  previewStatus: LocalPreviewStatus
  preview: LocalRepoInfo | null
  previewError: string | null
  disabled?: boolean
}

/**
 * Directory picker for an existing local checkout: a path field (typed or
 * filled by the native folder dialog) plus an inline verdict on whether that
 * directory is a git work tree, and what it holds.
 */
export function LocalRepoForm({
  repoDir,
  onRepoDirChange,
  onBrowse,
  previewStatus,
  preview,
  previewError,
  disabled,
}: LocalRepoFormProps) {
  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="git-clone-repo-dir"
          className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5"
        >
          Repository directory
          <InfoTooltip>
            A repository you have already cloned. Pick any directory inside the
            checkout — the repository root is resolved for you. Nothing is
            cloned, fetched, or modified when you select it.
          </InfoTooltip>
        </label>
        <div className="flex items-center gap-2">
          <input
            id="git-clone-repo-dir"
            type="text"
            value={repoDir}
            onChange={(e) => onRepoDirChange(e.target.value)}
            placeholder="/path/to/your/repo"
            disabled={disabled}
            className="flex-1 px-3 py-2 text-sm border border-input rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:bg-muted disabled:text-muted-foreground placeholder:text-muted-foreground"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onBrowse}
            disabled={disabled}
          >
            <FolderOpen className="size-4 mr-1" />
            Browse…
          </Button>
        </div>
      </div>

      {/* Inline verdict on the directory currently in the field */}
      {previewStatus === 'checking' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Checking directory…
        </div>
      )}

      {/* Deliberately NOT success-styled: this only reports what the directory
          is, and no outputs exist until the user confirms below. Green is
          reserved for the completed state, or a checked directory reads as a
          finished block and downstream blocks look broken for want of outputs
          nobody produced yet. */}
      {previewStatus === 'valid' && preview && (
        <div className="p-3 bg-info-muted border border-info/40 rounded-md space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-info">
            <FolderGit2 className="size-4 shrink-0" />
            Git repository found
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Root: <code className="font-mono">{preview.absolutePath}</code>
            </div>
            {preview.remoteUrl && (
              <div>
                Remote: <code className="font-mono">{preview.remoteUrl}</code>
              </div>
            )}
            <div>
              {preview.ref
                ? <>On {preview.refType === 'tag' ? 'tag' : preview.refType === 'detached' ? 'commit' : 'branch'} <code className="font-mono">{preview.ref}</code></>
                : 'No commits yet'}
              {' · '}
              {preview.fileCount} tracked {preview.fileCount === 1 ? 'file' : 'files'}
            </div>
            {!preview.remoteUrl && (
              <div className="text-warning-foreground">
                No remote — this repo produces no <code className="font-mono">repo_owner</code> or{' '}
                <code className="font-mono">repo_name</code>, and blocks that open a pull request need one.
              </div>
            )}
            <div className="pt-1 text-foreground">
              Not in use yet — choose <strong>Use This Repo</strong> to make this repository
              and its outputs available to later blocks.
            </div>
          </div>
        </div>
      )}

      {previewStatus === 'invalid' && (
        <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
          <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-destructive m-0">Can&apos;t use this directory</p>
            <p className="text-xs text-destructive m-0 mt-0.5 font-mono">{previewError}</p>
          </div>
        </div>
      )}
    </div>
  )
}
