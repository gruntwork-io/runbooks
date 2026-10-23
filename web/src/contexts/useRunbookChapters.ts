import { useContext } from "react"
import { flushSync } from "react-dom"
import {
  CHAPTER_INDEX_ATTRIBUTE,
  ChaptersControlContext,
  RunbookChaptersContext,
  type ChaptersControl,
  type RunbookChapters,
} from "./RunbookChaptersContext.types"

/** The open runbook's chapters, and the one on screen. */
export function useRunbookChapters(): RunbookChapters {
  return useContext(RunbookChaptersContext)
}

/** Changes the open runbook's chapters, or the one on screen. */
export function useChaptersControl(): ChaptersControl {
  return useContext(ChaptersControlContext)
}

/**
 * Returns a function that puts the chapter holding an element on screen, if
 * it is hidden, before the caller scrolls to the element: a hidden chapter's
 * content has no layout to scroll to. Call it from an event handler, since it
 * renders the chapter at once.
 */
export function useShowChapterOf(): (element: Element | null | undefined) => void {
  const { show } = useChaptersControl()
  return (element) => {
    const chapter = element?.closest<HTMLElement>(`[${CHAPTER_INDEX_ATTRIBUTE}]`)
    if (!chapter?.hidden) return
    flushSync(() => show(Number(chapter.getAttribute(CHAPTER_INDEX_ATTRIBUTE))))
  }
}
