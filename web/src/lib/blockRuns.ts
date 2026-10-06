import type { BlockRun } from "@/contexts/BlockRunsContext.types"
import { normalizeBlockId } from "@/lib/utils"

/**
 * Why a running block holds this one back: this block waits for it (it uses
 * the block's outputs, or names it in `dependsOn`), or one of the two is
 * `exclusive`.
 */
export type RunningBlockerReason = "dependency" | "exclusive"

export interface RunningBlocker {
  run: BlockRun
  reason: RunningBlockerReason
}

export interface RunBlockers {
  /** Running blocks that must finish, or be stopped, before this block can run. */
  running: RunningBlocker[]
  /** `dependsOn` ids whose latest run is neither running nor successful. */
  notSucceeded: string[]
}

/**
 * Works out what stops a block from running, given the status of every block.
 *
 * A block waits for a running block whose outputs its script references, since
 * those outputs are about to change. It waits for each `dependsOn` block to be
 * done running with a success or a warning. An `exclusive` block runs alone:
 * it waits for every running block, and every block waits for it.
 */
export function computeRunBlockers(params: {
  blockId: string
  exclusive: boolean
  /** Ids of the blocks whose outputs this block's script references. */
  outputDependencyIds: readonly string[]
  dependsOn: readonly string[]
  runs: Record<string, BlockRun>
}): RunBlockers {
  const { blockId, exclusive, outputDependencyIds, dependsOn, runs } = params
  const self = normalizeBlockId(blockId)
  const awaited = new Set([...outputDependencyIds, ...dependsOn].map(normalizeBlockId))

  const running: RunningBlocker[] = []
  for (const [key, run] of Object.entries(runs)) {
    if (key === self || run.status !== "running") continue
    if (awaited.has(key)) {
      running.push({ run, reason: "dependency" })
      continue
    }
    if (exclusive || run.exclusive) running.push({ run, reason: "exclusive" })
  }

  const notSucceeded = dependsOn.filter((id) => {
    const status = runs[normalizeBlockId(id)]?.status
    return status !== "running" && status !== "success" && status !== "warn"
  })

  return { running, notSucceeded }
}

/** Reports whether anything in `blockers` stops the block from running. */
export function isRunBlocked(blockers: RunBlockers): boolean {
  return blockers.running.length > 0 || blockers.notSucceeded.length > 0
}
