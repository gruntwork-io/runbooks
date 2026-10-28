import { usePageBlocks, useRevealBlock } from "@/contexts/ComponentIdRegistry"
import { cn } from "@/lib/utils"

interface BlockLinkProps {
  /** The id of the block to link to, as written or as a template refers to it. */
  blockId: string
  /** Background of the id's chip, to match the message it is in. */
  className?: string
}

/**
 * Another block's id, in the message of a block that is waiting on it.
 * Clicking it scrolls to that block. An id no block on the page has stays
 * plain text, since there is nothing to go to.
 */
export function BlockLink({ blockId, className = "bg-warning-muted" }: BlockLinkProps) {
  const { isOnPage } = usePageBlocks()
  const revealBlock = useRevealBlock()
  const chip = <code className={cn("px-1 rounded text-xs", className)}>{blockId}</code>
  if (isOnPage(blockId) === false) return chip

  return (
    <button
      type="button"
      className="cursor-pointer underline underline-offset-2"
      onClick={() => revealBlock(blockId)}
    >
      {chip}
    </button>
  )
}
