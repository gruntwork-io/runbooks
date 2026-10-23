import { createContext } from "react"
import type { RunbookProgress } from "./RunbookProgressContext.types"

/** A chapter of the open runbook, as its <Chapter> block names it. */
export interface ChapterInfo {
  /** The block's `title`, or "" when it has none. */
  title: string
}

/** The open runbook's chapters, and the one on screen. */
export interface RunbookChapters {
  /**
   * The chapters in document order. Empty for a runbook without any, which
   * shows all of its content at once.
   */
  chapters: readonly ChapterInfo[]
  /** The index of the chapter on screen. The others stay mounted, but hidden. */
  current: number
  /** Each chapter's steps and how many of them are done, by index, once it has counted them. */
  progress: readonly (RunbookProgress | undefined)[]
  /**
   * How many moves goTo has made. The chapter it moves to scrolls into view
   * and takes focus when this changes, which a move made with show() leaves
   * to its caller.
   */
  navigation: number
}

/** What changes the open runbook's chapters. */
export interface ChaptersControl {
  /**
   * Replace the chapters, as the runbook compiles; [] when it closes. A
   * recompile keeps the chapter on screen, or the last one if that is gone.
   */
  setChapters: (chapters: readonly ChapterInfo[]) => void
  /** Go to a chapter, which comes into view and takes focus. */
  goTo: (index: number) => void
  /** Show a chapter, for a caller that then scrolls to something in it. */
  show: (index: number) => void
  /** Record how many of a chapter's steps there are, and how many are done. */
  reportProgress: (index: number, progress: RunbookProgress) => void
}

/** The open runbook's chapters. Outside a RunbookChaptersProvider, none. */
export const RunbookChaptersContext = createContext<RunbookChapters>({
  chapters: [],
  current: 0,
  progress: [],
  navigation: 0,
})

/**
 * Kept apart from RunbookChaptersContext, like ProgressRegistryContext, so
 * what only changes the chapters doesn't re-render as they change.
 * Outside a provider, it does nothing.
 */
export const ChaptersControlContext = createContext<ChaptersControl>({
  setChapters: () => {},
  goTo: () => {},
  show: () => {},
  reportProgress: () => {},
})

/**
 * The attribute holding a chapter's index on its element, which is hidden
 * while another chapter is on screen.
 */
export const CHAPTER_INDEX_ATTRIBUTE = "data-chapter-index"
