import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import type { GitWorkTree } from "@/contexts/gitWorkTreeTypes"
import { normalizeBlockId } from "@/lib/utils"
import type { AppError } from "@/types/error"

export interface CloneChoice {
  /** The <GitClone> block the block works in, once the page's blocks have registered. */
  readonly cloneId?: string
  /** Its clone, once it's cloned. */
  readonly workTree?: GitWorkTree
  /** What's wrong with the runbook's clones for this block. */
  readonly error: AppError | null
}

/** Which block asks, for messages and for finding the clone above it. */
export interface CloneAsker {
  /** The block's id. */
  readonly id: string
  /** The block in messages, such as `<TerragruntApply>`. */
  readonly block: string
  /** What the clone holds for it, such as "the unit". */
  readonly holds: string
  /**
   * Without any <GitClone> block, work in the active repository instead of
   * raising a configuration error, as a pull request block does for a
   * repository opened another way.
   */
  readonly activeWithoutClone?: boolean
}

/**
 * The <GitClone> block a block works in: the one `gitCloneId` names, the
 * runbook's only one, or the nearest one above the block, as a reader
 * would take it. Without one above it, several clones need `gitCloneId`.
 */
export function useClone(gitCloneId: string | undefined, asker: CloneAsker): CloneChoice {
  const { block, holds } = asker
  const { blockOf, blocksOf, blocksAbove, registered } = usePageBlocks()
  const { workTrees, activeWorkTree } = useGitWorkTree()
  const withTree = (cloneId: string): CloneChoice => {
    const workTree = workTrees.find(
      (tree) => normalizeBlockId(tree.id) === normalizeBlockId(cloneId),
    )
    return { cloneId, ...(workTree ? { workTree } : {}), error: null }
  }
  if (!registered) return { error: null }
  if (gitCloneId) {
    if (blockOf(gitCloneId)?.kind !== "GitClone") {
      return {
        error: {
          message: `The ${block} block's gitCloneId names "${gitCloneId}", which isn't a <GitClone> block in this runbook.`,
          details: `Set gitCloneId to the id of the <GitClone> block whose clone holds ${holds}.`,
        },
      }
    }
    return withTree(gitCloneId)
  }
  const clones = blocksOf("GitClone")
  if (clones.length === 0) {
    if (asker.activeWithoutClone)
      return { ...(activeWorkTree ? { workTree: activeWorkTree } : {}), error: null }
    return {
      error: {
        message: `The ${block} block needs a <GitClone> block in the runbook.`,
        details: `It works in the repository a <GitClone> block clones, which holds ${holds}. Add one above it.`,
      },
    }
  }
  if (clones.length > 1) {
    const nearest = blocksAbove("GitClone", asker.id).at(-1)
    if (nearest) return withTree(nearest.id)
    return {
      error: {
        message: `The runbook has ${clones.length} <GitClone> blocks and none above the ${block} block, so it needs a gitCloneId.`,
        details: `Set gitCloneId to the one whose clone holds ${holds}: ${clones.map((clone) => `"${clone.id}"`).join(", ")}.`,
      },
    }
  }
  return withTree(clones[0]!.id)
}
