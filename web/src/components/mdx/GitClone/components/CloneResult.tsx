import { CheckCircle, AlertTriangle, FolderOpen, Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import type { CloneResult, GitCloneSource } from "../types"

interface CloneResultDisplayProps {
  result: CloneResult
  /** Where the repo came from — drives the copy, since nothing was downloaded
   *  when the user picked a checkout they already had. Defaults to 'clone'. */
  source?: GitCloneSource
  /** Remote of the selected local checkout, shown so the user can confirm it. */
  remoteUrl?: string
  /**
   * Render in the warning tone instead of the success tone. Used when the repo
   * arrived without commits: the clone itself worked, but the block is not done
   * — nothing downstream can use the repo until it has a default branch.
   */
  warn?: boolean
  onCloneAgain: () => void
}

/**
 * Every class the panel can take, spelled out per tone. Composing them from a
 * variable (`bg-${tone}-muted`) would leave Tailwind's scanner unable to see
 * them, so both sets stay literal.
 */
const TONES = {
  success: {
    panel: 'bg-success-muted border border-success/30 rounded-md p-4 space-y-2',
    heading: 'flex items-center gap-2 text-success font-medium',
    text: 'text-success',
    label: 'text-sm font-medium text-success',
    smallLabel: 'text-xs text-success',
    code: 'text-sm bg-success-muted px-1.5 py-0.5 rounded font-mono text-success',
    copyButton: 'shrink-0 p-0.5 text-success hover:text-success cursor-pointer',
    row: 'flex items-center gap-2 text-success',
    remote: 'text-sm text-success',
  },
  warning: {
    panel: 'bg-warning-muted border border-warning/30 rounded-md p-4 space-y-2',
    heading: 'flex items-center gap-2 text-warning-foreground font-medium',
    text: 'text-warning-foreground',
    label: 'text-sm font-medium text-warning-foreground',
    smallLabel: 'text-xs text-warning-foreground',
    code: 'text-sm bg-warning-muted px-1.5 py-0.5 rounded font-mono text-warning-foreground',
    copyButton: 'shrink-0 p-0.5 text-warning-foreground hover:text-warning-foreground cursor-pointer',
    row: 'flex items-center gap-2 text-warning-foreground',
    remote: 'text-sm text-warning-foreground',
  },
} as const

export function CloneResultDisplay({ result, source = 'clone', remoteUrl, warn = false, onCloneAgain }: CloneResultDisplayProps) {
  const relative = useCopyToClipboard(2000)
  const absolute = useCopyToClipboard(2000)
  const isLocal = source === 'local'
  const t = warn ? TONES.warning : TONES.success

  return (
    <div className="space-y-3">
      {/* Result panel */}
      <div className={t.panel}>
        <div className={t.heading}>
          {warn ? (
            <AlertTriangle className="size-5 text-warning" />
          ) : (
            <CheckCircle className="size-5 text-success" />
          )}
          {isLocal ? 'Using local checkout' : 'Clone complete'}
        </div>

        <div className={t.row}>
          <FolderOpen className={`size-4 ${t.text}`} />
          <span>
            {isLocal
              ? `${result.fileCount} tracked ${result.fileCount === 1 ? 'file' : 'files'}`
              : `Downloaded ${result.fileCount} files`}
          </span>
        </div>

        {isLocal && remoteUrl && (
          <div className={t.remote}>
            Remote: <code className="font-mono">{remoteUrl}</code>
          </div>
        )}

        <div className="space-y-1">
          <span className={t.label}>
            {isLocal ? 'Repository path:' : 'Local path:'}
          </span>
          {/* A checkout outside the working directory has no meaningful
              relative form — the domain layer returns the absolute path for
              both, so don't print it twice. */}
          <div className={`flex items-center gap-1.5 ${result.relativePath === result.absolutePath ? 'hidden' : ''}`}>
            <span className={t.smallLabel}>Relative:</span>
            <code className={t.code}>
              {result.relativePath}
            </code>
            <button
              onClick={() => relative.copy(result.relativePath)}
              className={t.copyButton}
            >
              {relative.didCopy ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={t.smallLabel}>Absolute:</span>
            <code className={t.code}>
              {result.absolutePath}
            </code>
            <button
              onClick={() => absolute.copy(result.absolutePath)}
              className={t.copyButton}
            >
              {absolute.didCopy ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Start over: clone again, or pick a different checkout */}
      <Button
        variant="outline"
        size="sm"
        onClick={onCloneAgain}
        className="text-muted-foreground"
      >
        {isLocal ? 'Choose a different repo' : 'Clone again'}
      </Button>
    </div>
  )
}
