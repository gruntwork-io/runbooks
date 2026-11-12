import type { RunbookProgress } from "@/contexts/RunbookProgressContext.types"

function progressText({ done, total }: RunbookProgress): string {
  return `${done} of ${total} ${total === 1 ? "step" : "steps"} done`
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
