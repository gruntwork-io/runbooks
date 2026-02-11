import { CheckCircle, ExternalLink, Loader2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PRResult, PRBlockStatus } from "../types"

interface PRResultDisplayProps {
  result: PRResult
  status: PRBlockStatus
  pushError: string | null
  onPush: () => void
  onCreateAnother: () => void
}

export function PRResultDisplay({ result, status, pushError, onPush, onCreateAnother }: PRResultDisplayProps) {
  const isPushing = status === 'pushing'

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

      {/* Action buttons */}
      <div className="flex items-center gap-2">
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
        <Button
          size="sm"
          variant="outline"
          onClick={onCreateAnother}
          disabled={isPushing}
          className="text-gray-600"
        >
          Create Another
        </Button>
      </div>
    </div>
  )
}
