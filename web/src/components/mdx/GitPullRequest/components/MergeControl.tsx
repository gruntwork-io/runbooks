import { CheckCircle, GitMerge, Loader2, RefreshCw, TriangleAlert, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { MergeMethod } from "../../../../../../src/services/GitHubClient"
import type { PrMerge } from "../hooks/usePrMerge"

/** The button's words for each method, as GitHub words them. */
const METHOD_LABELS: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
}

interface MergeControlProps {
  readonly merge: PrMerge
  /** Why one of the block's own merge conditions doesn't hold, which keeps Merge disabled. */
  readonly blockedBy?: string
}

/**
 * The Merge button a block with `allowPullRequestMerge` shows under its pull
 * request: enabled once GitHub says it can merge and the block's own merge
 * conditions hold, and otherwise disabled with the reason.
 */
export function MergeControl({ merge, blockedBy }: MergeControlProps) {
  const { state, checkError, merging, mergeError, refresh } = merge

  if (state?.state === "merged") {
    return (
      <div
        data-testid="pr-merge"
        className="flex items-center gap-2 text-sm text-success font-medium"
      >
        <CheckCircle className="size-4" />
        Merged
        {state.sha ? <code className="font-mono text-xs">{state.sha.slice(0, 7)}</code> : null}
      </div>
    )
  }

  if (state?.state === "closed") {
    return (
      <div data-testid="pr-merge" className="text-sm text-muted-foreground">
        It's closed without merging, so there's nothing to merge.
      </div>
    )
  }

  const ready = state?.mergeability === "ready" && blockedBy === undefined
  const label = state?.method ? METHOD_LABELS[state.method] : "Merge"

  return (
    <div data-testid="pr-merge" className="space-y-2">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={merge.merge} disabled={!ready || merging}>
          {merging ? (
            <>
              <Loader2 className="size-4 mr-1 animate-spin" />
              Merging...
            </>
          ) : (
            <>
              <GitMerge className="size-4 mr-1" />
              {label}
            </>
          )}
        </Button>
        <button
          type="button"
          onClick={refresh}
          disabled={merging}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className="size-3" />
          Check again
        </button>
      </div>
      {state === undefined && !checkError && (
        <p className="text-xs text-muted-foreground m-0">Asking GitHub whether it can merge...</p>
      )}
      {state?.reason && <p className="text-xs text-muted-foreground m-0">{state.reason}</p>}
      {blockedBy && <p className="text-xs text-muted-foreground m-0">{blockedBy}</p>}
      {state?.warning && (
        <p className="flex items-start gap-1.5 text-xs text-warning-foreground m-0">
          <TriangleAlert className="size-3.5 mt-0.5 shrink-0" />
          {state.warning}
        </p>
      )}
      {(checkError ?? mergeError) && (
        <div className="flex items-start gap-1.5 text-xs text-destructive">
          <XCircle className="size-3.5 mt-0.5 shrink-0" />
          <span className="font-mono">
            {mergeError ? `Merge failed: ${mergeError}` : `Couldn't ask GitHub: ${checkError}`}
          </span>
        </div>
      )}
    </div>
  )
}
