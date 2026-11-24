import type { BlockRun, BlockRunStatus } from "@/contexts/BlockRunsContext.types"
import { normalizeBlockId } from "@/lib/utils"
import {
  parseShowWhenBlock,
  showWhenBlockHolds,
  type ShowWhenBlock,
} from "../../../src/domain/exec/showWhenBlock.ts"

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

export interface ShowWhenBlockState {
  /** Whether the block shows. A block with an error in its condition shows, with the error. */
  shown: boolean
  /** The block's condition, or null without a valid one. */
  condition: ShowWhenBlock | null
  /** What's wrong with the block's `showWhenBlock` prop, or null. */
  error: string | null
}

/**
 * Works out whether a block with a `showWhenBlock` prop shows: while the
 * latest run of the block it names ended as the prop says, and while the
 * block itself is running, so a run that's going stays in view.
 */
export function showWhenBlockState(params: {
  blockId: string
  /** The block's `showWhenBlock` prop as the runbook sets it. */
  value: unknown
  /** The block's own status. */
  status: BlockRunStatus
  runs: Record<string, BlockRun>
  /**
   * Whether a block on the page has the id the prop names; undefined until
   * blocks have registered (usePageBlocks).
   */
  isOnPage: boolean | undefined
}): ShowWhenBlockState {
  const { blockId, value, status, runs, isOnPage } = params
  const parsed = parseShowWhenBlock(value)
  if (!parsed.ok) return { shown: true, condition: null, error: parsed.error }
  const condition = parsed.condition
  if (!condition) return { shown: true, condition: null, error: null }

  const key = normalizeBlockId(condition.id)
  if (key === normalizeBlockId(blockId)) {
    return { shown: true, condition: null, error: "showWhenBlock can't name the block itself." }
  }
  const target = runs[key]
  // A block on the page that never reports a run isn't one with runs.
  if (isOnPage === false || (isOnPage === true && target === undefined)) {
    return {
      shown: true,
      condition: null,
      error: `showWhenBlock names "${condition.id}", but no Check, Command, Finish or Prerequisites block has that id.`,
    }
  }
  const shown = status === "running" || showWhenBlockHolds(condition, target?.status)
  return { shown, condition, error: null }
}
