import { CheckCircle, FolderOpen, Copy, Check } from "lucide-react"
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
  onCloneAgain: () => void
}

export function CloneResultDisplay({ result, source = 'clone', remoteUrl, onCloneAgain }: CloneResultDisplayProps) {
  const relative = useCopyToClipboard(2000)
  const absolute = useCopyToClipboard(2000)
  const isLocal = source === 'local'

  return (
    <div className="space-y-3">
      {/* Success panel */}
      <div className="bg-success-muted border border-success/30 rounded-md p-4 space-y-2">
        <div className="flex items-center gap-2 text-success font-medium">
          <CheckCircle className="size-5 text-success" />
          {isLocal ? 'Using local checkout' : 'Clone complete'}
        </div>

        <div className="flex items-center gap-2 text-success">
          <FolderOpen className="size-4 text-success" />
          <span>
            {isLocal
              ? `${result.fileCount} tracked ${result.fileCount === 1 ? 'file' : 'files'}`
              : `Downloaded ${result.fileCount} files`}
          </span>
        </div>

        {isLocal && remoteUrl && (
          <div className="text-sm text-success">
            Remote: <code className="font-mono">{remoteUrl}</code>
          </div>
        )}

        <div className="space-y-1">
          <span className="text-sm font-medium text-success">
            {isLocal ? 'Repository path:' : 'Local path:'}
          </span>
          {/* A checkout outside the working directory has no meaningful
              relative form — the domain layer returns the absolute path for
              both, so don't print it twice. */}
          <div className={`flex items-center gap-1.5 ${result.relativePath === result.absolutePath ? 'hidden' : ''}`}>
            <span className="text-xs text-success">Relative:</span>
            <code className="text-sm bg-success-muted px-1.5 py-0.5 rounded font-mono text-success">
              {result.relativePath}
            </code>
            <button
              onClick={() => relative.copy(result.relativePath)}
              className="shrink-0 p-0.5 text-success hover:text-success cursor-pointer"
            >
              {relative.didCopy ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-success">Absolute:</span>
            <code className="text-sm bg-success-muted px-1.5 py-0.5 rounded font-mono text-success">
              {result.absolutePath}
            </code>
            <button
              onClick={() => absolute.copy(result.absolutePath)}
              className="shrink-0 p-0.5 text-success hover:text-success cursor-pointer"
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
