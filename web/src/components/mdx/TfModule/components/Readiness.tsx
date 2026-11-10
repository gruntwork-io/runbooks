import { CircleCheck, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react"
import type { ReadinessProblem, ReadinessReport } from "../readiness"

interface ReadinessProps {
  report: ReadinessReport | undefined
  /** Why the check couldn't run at all. */
  error?: string | undefined
  checking: boolean
  onRecheck: () => void
}

/**
 * What the block needs outside its inputs: the problems with their fixes, or
 * one quiet line of what's in place. Nothing until the first check answers.
 */
export function Readiness({ report, error, checking, onRecheck }: ReadinessProps) {
  if (error) {
    return (
      <Problems
        problems={[
          {
            key: "error",
            text: `Couldn't check what the block needs: ${error}`,
          },
        ]}
        checking={checking}
        onRecheck={onRecheck}
      />
    )
  }
  if (!report) return null
  if (report.problems.length > 0) {
    return <Problems problems={report.problems} checking={checking} onRecheck={onRecheck} />
  }
  if (report.ready.length === 0) return null
  return (
    <p
      className="m-0 mb-4 flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-label="Ready"
    >
      <CircleCheck className="size-3.5 shrink-0 text-success" />
      <span>Ready: {report.ready.join(" · ")}</span>
    </p>
  )
}

function Problems({
  problems,
  checking,
  onRecheck,
}: {
  problems: readonly ReadinessProblem[]
  checking: boolean
  onRecheck: () => void
}) {
  return (
    <div
      className="mb-4 rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-warning-foreground"
      role="status"
      aria-label="Before you plan"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 flex items-center gap-1.5 font-medium">
          <TriangleAlert className="size-4 shrink-0" /> Before you plan
        </p>
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/40 bg-card px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`size-3 ${checking ? "animate-spin" : ""}`} />
          Check again
        </button>
      </div>
      <ul className="m-0 mt-2 list-none space-y-1.5 p-0">
        {problems.map((problem) => (
          <li key={problem.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span>{problem.text}</span>
            {problem.fix && (
              <a
                href={problem.fix.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
              >
                {problem.fix.label}
                <ExternalLink className="size-3" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
