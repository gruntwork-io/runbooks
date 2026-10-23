import type { RefObject } from "react"
import { useShowChapterOf } from "@/contexts/useRunbookChapters"

/**
 * Returns a function that scrolls the block in `ref` to the middle of the
 * view, for another block's link to it. A block in a hidden chapter shows
 * that chapter first.
 */
export function useRevealSelf(ref: RefObject<HTMLElement | null>): () => void {
  const showChapterOf = useShowChapterOf()
  return () => {
    showChapterOf(ref.current)
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }
}
