import { useMemo } from "react"
import { XCircle } from "lucide-react"
import { Admonition } from "@/components/mdx/Admonition"
import { Button } from "@/components/ui/button"
import { DiffTable } from "@/components/artifacts/code/DiffTable"
import { diffDiskContents } from "@/lib/unifiedDiff"
import type { AppError } from "@/types/error"
import type { ScriptFileChange } from "../../../../../../electron/shared/channels.ts"

interface ScriptChangeNoticeProps {
  /** The block's `path` prop, as the author wrote it. */
  path: string
  change: ScriptFileChange
  onReload: () => void
  isReloading: boolean
  reloadError: AppError | null
}

/**
 * Tells the user that a block's script file changed on disk after Runbooks
 * loaded it, shows the change, and offers to reload the script. Until they
 * do, Run executes the loaded version.
 */
export function ScriptChangeNotice({ path, change, onReload, isReloading, reloadError }: ScriptChangeNoticeProps) {
  const diffLines = useMemo(
    () => diffDiskContents(change.registeredContent, change.diskContent),
    [change.registeredContent, change.diskContent],
  )
  const hasChangedLines = diffLines.some((line) => line.type !== "context")

  return (
    // mr-12 leaves room for the block's ID label
    <Admonition type="warning" title="Script changed" className="mr-12">
      <div className="space-y-2">
        <p>
          <code className="bg-warning-muted px-1 rounded text-xs">{path}</code> has changed on disk since Runbooks loaded it.
          Run still executes the version Runbooks loaded, which is the one under <em>View Source Code</em>.
          Review the change, then reload the script to run the new version.
        </p>

        {hasChangedLines ? (
          <div
            data-testid="script-change-diff"
            className="max-h-80 overflow-auto rounded-sm border border-border bg-background text-foreground"
          >
            <DiffTable diffLines={diffLines} />
          </div>
        ) : (
          <p>The two versions differ only in line endings or a final newline.</p>
        )}

        {reloadError && (
          <div className="text-destructive flex items-start gap-2">
            <XCircle className="size-4 mt-0.5 flex-shrink-0" />
            <span className="min-w-0">{reloadError.message}</span>
          </div>
        )}

        <Button variant="outline" size="sm" disabled={isReloading} onClick={onReload}>
          Reload script
        </Button>
      </div>
    </Admonition>
  )
}
