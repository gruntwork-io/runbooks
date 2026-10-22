import { AlertTriangle } from "lucide-react"
import type { RunBlockers, RunningBlocker } from "@/lib/blockRuns"

interface RunBlockedWarningProps {
  /** The type of block (used in the help text) */
  blockType: string
  /** Whether this block is marked `exclusive` */
  exclusive: boolean
  blockers: RunBlockers
  /** Stops the named block's running script */
  onStop: (blockId: string) => void
  /** Scrolls the named block into view */
  onReveal: (blockId: string) => void
}

function runningReason(blocker: RunningBlocker, blockType: string, exclusive: boolean): string {
  if (blocker.reason === "dependency") return `This ${blockType} runs after it.`
  if (blocker.run.exclusive) return "It can't run alongside other blocks."
  return exclusive ? `This ${blockType} can't run alongside other blocks.` : ""
}

/**
 * Explains why a block can't run yet because of other blocks' runs: a block it
 * has to wait for is still running, or a block it depends on hasn't succeeded.
 * Each running block gets a link to it and a button to stop it.
 */
export const RunBlockedWarning: React.FC<RunBlockedWarningProps> = ({
  blockType,
  exclusive,
  blockers,
  onStop,
  onReveal,
}) => {
  const { running, notSucceeded } = blockers
  if (running.length === 0 && notSucceeded.length === 0) return null

  return (
    <div
      data-testid="run-blocked-warning"
      className="mb-3 text-sm text-warning-foreground flex items-start gap-2"
    >
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        {running.map((blocker) => (
          <div key={blocker.run.blockId} className="mb-1">
            <strong>Waiting for a running block:</strong>{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2"
              onClick={() => onReveal(blocker.run.blockId)}
            >
              <code className="bg-warning-muted px-1 rounded text-xs">{blocker.run.blockId}</code>
            </button>{" "}
            {runningReason(blocker, blockType, exclusive)}{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 text-destructive"
              onClick={() => onStop(blocker.run.blockId)}
            >
              Stop {blocker.run.blockId}
            </button>
          </div>
        ))}
        {notSucceeded.length > 0 && (
          <div>
            <strong>Waiting for:</strong>{" "}
            {notSucceeded.map((blockId, i) => (
              <span key={blockId}>
                {i > 0 && ", "}
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={() => onReveal(blockId)}
                >
                  <code className="bg-warning-muted px-1 rounded text-xs">{blockId}</code>
                </button>
              </span>
            ))}
            <div className="text-xs mt-1 text-warning-foreground">
              Run the above block(s) successfully to use this {blockType}.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
