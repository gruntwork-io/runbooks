import { CircleCheck } from "lucide-react"
import type { RunbookProgress } from "@/contexts/RunbookProgressContext.types"
import { cn } from "@/lib/utils"

function progressText({ done, total }: RunbookProgress): string {
  return `${done} of ${total} ${total === 1 ? "step" : "steps"} done`
}

/** How many of the runbook's steps are done, e.g. "2 of 5 steps done", for the title bar. */
export function RunbookProgressCount({ progress }: { progress: RunbookProgress }) {
  const finished = progress.done === progress.total
  return (
    <span
      data-testid="runbook-progress-count"
      className={cn(
        "flex flex-shrink-0 items-center gap-1 text-xs font-normal tabular-nums",
        finished ? "text-success" : "text-muted-foreground",
      )}
    >
      {finished && <CircleCheck aria-hidden className="size-3.5" />}
      {progressText(progress)}
    </span>
  )
}

/**
 * A thin bar along the bottom edge of the title bar, filled in proportion to
 * the steps done. Place it in a positioned element.
 */
export function RunbookProgressBar({ progress }: { progress: RunbookProgress }) {
  return (
    <div
      role="progressbar"
      aria-label="Runbook progress"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
      aria-valuetext={progressText(progress)}
      data-testid="runbook-progress-bar"
      className="absolute inset-x-0 -bottom-px h-[3px]"
    >
      <div
        className="h-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${(progress.done / progress.total) * 100}%` }}
      />
    </div>
  )
}
