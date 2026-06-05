import { useState } from "react"
import { CheckCircle, ExternalLink, Loader2, XCircle, CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CollapsibleToggle } from "./CollapsibleToggle"
import type { PRProviderConfig } from "../providers"
import type { PRResult, PRBlockStatus, ChangeSummary } from "../types"

interface PRResultDisplayProps {
  /** The change-request noun (Pull Request / Merge Request) for all copy. */
  noun: PRProviderConfig["noun"]
  /** Display ref symbol: GitHub `#`, GitLab `!`. */
  refSymbol: PRProviderConfig["refSymbol"]
  result: PRResult
  status: PRBlockStatus
  pushError: string | null
  changeSummary: ChangeSummary | null
  onPush: () => void
  onCreateAnother: () => void
}

export function PRResultDisplay({ noun, refSymbol, result, status, pushError, changeSummary, onPush, onCreateAnother }: PRResultDisplayProps) {
  const isPushing = status === 'pushing'
  const [whatFilesExpanded, setWhatFilesExpanded] = useState(false)

  return (
    <div className="space-y-3">
      {/* Success panel */}
      <div className="bg-success-muted border border-success/30 rounded-md p-4 space-y-2">
        <div className="flex items-center gap-2 text-success font-medium">
          <CheckCircle className="size-5 text-success" />
          {noun.abbrev} {refSymbol}{result.prNumber} opened successfully
        </div>

        <div className="space-y-1">
          <a
            href={result.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 hover:underline"
          >
            {result.prUrl}
            <ExternalLink className="size-3.5" />
          </a>
          <div className="text-xs text-success">
            Branch: <code className="bg-success-muted px-1 py-0.5 rounded font-mono">{result.branchName}</code>
          </div>
        </div>
      </div>

      {/* Push error */}
      {pushError && (
        <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
          <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-destructive m-0">Push failed</p>
            <p className="text-xs text-destructive m-0 mt-0.5 font-mono">{pushError}</p>
          </div>
        </div>
      )}

      {/* Git Push button + "create another" link */}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={onPush}
          disabled={isPushing}
        >
          {isPushing ? (
            <>
              <Loader2 className="size-4 mr-1 animate-spin" />
              Pushing...
            </>
          ) : (
            'Git Push'
          )}
        </Button>
        <button
          type="button"
          onClick={onCreateAnother}
          disabled={isPushing}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          or create another {noun.abbrev}
        </button>
      </div>

      {/* What will Git Push commit? (collapsible) */}
      <CollapsibleToggle
        expanded={whatFilesExpanded}
        onToggle={() => setWhatFilesExpanded(!whatFilesExpanded)}
        label="What will Git Push commit?"
        icon={<CircleHelp className="size-3.5" />}
      >
        <div className="mt-1.5 ml-5 text-xs text-muted-foreground leading-relaxed">
          {changeSummary && changeSummary.fileCount > 0 ? (
            <p className="m-0">
              Git Push will commit and push{' '}
              <span className="font-medium">{changeSummary.fileCount}</span>{' '}
              {changeSummary.fileCount === 1 ? 'file' : 'files'}
              {(changeSummary.additions > 0 || changeSummary.deletions > 0) && (
                <>
                  {' '}(
                  {changeSummary.additions > 0 && (
                    <span className="text-success font-medium">+{changeSummary.additions}</span>
                  )}
                  {changeSummary.additions > 0 && changeSummary.deletions > 0 && ', '}
                  {changeSummary.deletions > 0 && (
                    <span className="text-destructive font-medium">&minus;{changeSummary.deletions}</span>
                  )}
                  )
                </>
              )}
              {' '}to the <code className="bg-muted px-1 py-0.5 rounded font-mono">{result.branchName}</code> branch.
              Review your changes in the <span className="font-semibold">Changed files</span> tab of the workspace panel.
            </p>
          ) : (
            <p className="m-0">
              No new file changes detected. If you make additional changes to the cloned repository,
              use Git Push to add them to the existing {noun.lower} on
              the <code className="bg-muted px-1 py-0.5 rounded font-mono">{result.branchName}</code> branch.
            </p>
          )}
        </div>
      </CollapsibleToggle>
    </div>
  )
}
