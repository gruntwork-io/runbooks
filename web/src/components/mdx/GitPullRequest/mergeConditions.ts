import type { AppError } from "@/types/error"

/**
 * The conditions a runbook can add, by keyword, before a block enables
 * Merge, on top of GitHub's own rules. Each is logic the block checks, so a
 * runbook names one instead of writing an expression.
 */
export const PULL_REQUEST_MERGE_CONDITIONS = ["no-uncommitted-changes"] as const

export type PullRequestMergeCondition = (typeof PULL_REQUEST_MERGE_CONDITIONS)[number]

/** What the conditions read about the block's clone. */
export interface MergeConditionFacts {
  /** Files the clone has changed and not committed. */
  readonly uncommittedFiles: number
  /** Whether the clone's changes are still being read. */
  readonly checking: boolean
}

/** Why a condition in `conditions` doesn't hold, or undefined when they all do. */
export function unmetMergeCondition(
  conditions: readonly PullRequestMergeCondition[],
  facts: MergeConditionFacts,
): string | undefined {
  if (conditions.includes("no-uncommitted-changes")) {
    if (facts.checking) return "Checking the clone for changes that aren't committed..."
    const n = facts.uncommittedFiles
    if (n > 0) {
      return `${n === 1 ? "1 file isn't" : `${n} files aren't`} committed yet. Push ${n === 1 ? "it" : "them"} to the pull request before merging.`
    }
  }
  return undefined
}

const isCondition = (name: string): name is PullRequestMergeCondition =>
  (PULL_REQUEST_MERGE_CONDITIONS as readonly string[]).includes(name)

/**
 * The configuration error for merge conditions a block can't use: ones it
 * doesn't know, or any without `allowPullRequestMerge`. Null when they're fine.
 */
export function mergeConditionsError(
  blockType: string,
  allowPullRequestMerge: boolean,
  conditions: readonly string[],
): AppError | null {
  if (conditions.length === 0) return null
  if (!allowPullRequestMerge) {
    return {
      message: `The <${blockType}> block's allowPullRequestMergeConditions needs allowPullRequestMerge.`,
      details: "Add allowPullRequestMerge, or remove allowPullRequestMergeConditions.",
    }
  }
  const unknown = conditions.filter((name) => !isCondition(name))
  if (unknown.length === 0) return null
  return {
    message: `The <${blockType}> block's allowPullRequestMergeConditions names ${unknown.map((name) => `"${name}"`).join(", ")}, which ${unknown.length === 1 ? "isn't a condition" : "aren't conditions"} it knows.`,
    details: `The conditions are: ${PULL_REQUEST_MERGE_CONDITIONS.join(", ")}.`,
  }
}

/** The conditions as the block checks them, once mergeConditionsError has found none it doesn't know. */
export const knownMergeConditions = (conditions: readonly string[]) =>
  conditions.filter(isCondition)
