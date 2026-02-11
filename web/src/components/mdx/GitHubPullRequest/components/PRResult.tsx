import { useState } from "react"
import { CheckCircle, ExternalLink, Loader2, XCircle, ChevronDown, ChevronRight, CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PRResult, PRBlockStatus } from "../types"
import type { ChangeSummary } from "./PRForm"

interface PRResultDisplayProps {
  result: PRResult
  status: PRBlockStatus
  pushError: string | null
  changeSummary: ChangeSummary | null
  onPush: () => void
  onCreateAnother: () => void
}

export function PRResultDisplay({ result, status, pushError, changeSummary, onPush, onCreateAnother }: PRResultDisplayProps) {
  const isPushing = status === 'pushing'
  const [whatFilesExpanded, setWhatFilesExpanded] = useState(false)

  return (
    <div className="space-y-3">
      {/* Success panel */}
      <div className="bg-green-50 border border-green-200 rounded-md p-4 space-y-2">
        <div className="flex items-center gap-2 text-green-800 font-medium">
          <CheckCircle className="size-5 text-green-600" />
          PR #{result.prNumber} opened successfully
        </div>

        <div className="space-y-1">
          <a
            href={result.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 hover:underline"
          >
            {result.prUrl}
            <ExternalLink className="size-3.5" />
          </a>
          <div className="text-xs text-green-600">
            Branch: <code className="bg-green-100 px-1 py-0.5 rounded font-mono">{result.branchName}</code>
          </div>
        </div>
      </div>

      {/* Push error */}
      {pushError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
          <XCircle className="size-4 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800 m-0">Push failed</p>
            <p className="text-xs text-red-600 m-0 mt-0.5 font-mono">{pushError}</p>
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
          className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          or create another PR
        </button>
      </div>

      {/* What files will be committed? (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setWhatFilesExpanded(!whatFilesExpanded)}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 cursor-pointer"
        >
          {whatFilesExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <CircleHelp className="size-3.5" />
          <span className="font-medium">What will Git Push commit?</span>
        </button>
        {whatFilesExpanded && (
          <div className="mt-1.5 ml-5 text-xs text-gray-600 leading-relaxed">
            {changeSummary && changeSummary.fileCount > 0 ? (
              <p className="m-0">
                Git Push will commit and push{' '}
                <span className="font-medium">{changeSummary.fileCount}</span>{' '}
                {changeSummary.fileCount === 1 ? 'file' : 'files'}
                {(changeSummary.additions > 0 || changeSummary.deletions > 0) && (
                  <>
                    {' '}(
                    {changeSummary.additions > 0 && (
                      <span className="text-green-600 font-medium">+{changeSummary.additions}</span>
                    )}
                    {changeSummary.additions > 0 && changeSummary.deletions > 0 && ', '}
                    {changeSummary.deletions > 0 && (
                      <span className="text-red-600 font-medium">&minus;{changeSummary.deletions}</span>
                    )}
                    )
                  </>
                )}
                {' '}to the <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">{result.branchName}</code> branch.
                Review your changes in the <span className="font-semibold">Changed files</span> tab of the workspace panel.
              </p>
            ) : (
              <p className="m-0">
                No new file changes detected. If you make additional changes to the cloned repository,
                use Git Push to add them to the existing pull request on
                the <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">{result.branchName}</code> branch.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
