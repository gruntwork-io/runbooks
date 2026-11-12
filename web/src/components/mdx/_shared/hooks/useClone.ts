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

/**
 * The <GitClone> block a block works in: the one `gitCloneId` names, or the
 * runbook's only one. A runbook with no clone, or several and no
 * `gitCloneId`, is a configuration error rather than a guess.
 *
 * `block` names the block in messages, such as `<TerragruntApply>`, and
 * `holds` says what the clone holds for it, such as "the unit".
 */
export function useClone(
  gitCloneId: string | undefined,
  block: string,
  holds: string,
): CloneChoice {
  const { blockOf, blocksOf, registered } = usePageBlocks()
  const { workTrees } = useGitWorkTree()
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
    return {
      error: {
        message: `The ${block} block needs a <GitClone> block in the runbook.`,
        details: `It works in the repository a <GitClone> block clones, which holds ${holds}. Add one above it.`,
      },
    }
  }
  if (clones.length > 1) {
    return {
      error: {
        message: `The runbook has ${clones.length} <GitClone> blocks, so the ${block} block needs a gitCloneId.`,
        details: `Set gitCloneId to the one whose clone holds ${holds}: ${clones.map((clone) => `"${clone.id}"`).join(", ")}.`,
      },
    }
  }
  return withTree(clones[0]!.id)
}
