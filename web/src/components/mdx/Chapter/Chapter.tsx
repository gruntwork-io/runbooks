import { useContext, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { ProgressRegistryContext } from "@/contexts/RunbookProgressContext.types"
import { CHAPTER_INDEX_ATTRIBUTE } from "@/contexts/RunbookChaptersContext.types"
import { useChaptersControl, useRunbookChapters } from "@/contexts/useRunbookChapters"
import { useStepCounter } from "@/contexts/useStepCounter"
import { ChapterBar, ChapterPager } from "./ChapterNav"

interface ChapterProps {
  /** The chapter's name, shown in the chapter bar and the table of contents. */
  title?: string
  /**
   * The chapter's place in the runbook. compileMDX sets it on each chapter at
   * the top level (see rehypeChapters); a runbook can't.
   */
  chapterIndex?: string
  children?: ReactNode
}

/**
 * Groups a runbook's content into chapters, shown one at a time, with a bar
 * to move between them and a table of contents. Only the layout changes: every
 * chapter stays mounted while hidden, so its blocks keep their state, and a
 * block can use the outputs of a block in any other chapter. Content outside
 * every chapter shows with each of them.
 */
export function Chapter({ title, chapterIndex, children }: ChapterProps) {
  const { chapters, current, navigation } = useRunbookChapters()
  const { reportProgress } = useChaptersControl()
  const { reportError, clearError } = useErrorReporting()
  const index = chapterIndex === undefined ? undefined : Number(chapterIndex)
  const isCurrent = index === current
  const errorId = useId()
  // A literal such as title={42} reaches the block as it is, not as text.
  const name = typeof title === "string" ? title.trim() : ""

  // Count this chapter's steps for its table of contents entry, while they
  // still count toward the runbook's own progress.
  const [progress, registry] = useStepCounter(useContext(ProgressRegistryContext))
  useEffect(() => {
    if (index !== undefined) reportProgress(index, progress)
  }, [index, progress, reportProgress])

  const configError =
    index === undefined
      ? "A <Chapter> must be at the top level of the runbook, not inside another block or chapter."
      : !name
        ? `Chapter ${index + 1} has no title. Name it with a title prop that holds text, such as <Chapter title="Deploy">.`
        : null
  useEffect(() => {
    if (!configError) return
    reportError({
      componentId: errorId,
      componentType: "Chapter",
      severity: "error",
      message: configError,
    })
    return () => clearError(errorId)
  }, [configError, errorId, reportError, clearError])

  // A move to this chapter with goTo brings its start into view, unless it
  // already is, and puts focus in it, since the control that moved here was
  // in the chapter now hidden. A remount, as on a watch-mode reload, doesn't.
  const sectionRef = useRef<HTMLElement>(null)
  const handledNavigation = useRef(navigation)
  useLayoutEffect(() => {
    if (navigation === handledNavigation.current) return
    handledNavigation.current = navigation
    const section = sectionRef.current
    if (!isCurrent || !section) return
    const scroller = scrollParent(section)
    if (scroller && section.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
      section.scrollIntoView({ block: "start" })
    }
    section.focus({ preventScroll: true })
  }, [navigation, isCurrent])

  const errorBox = configError && (
    <div className="runbook-block rounded-md border p-3 text-sm flex items-start gap-2 mb-5 bg-destructive-muted border-destructive/30 text-destructive">
      <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <div className="text-md font-bold mb-1">Invalid Chapter</div>
        <p>{configError}</p>
      </div>
    </div>
  )

  // Not a chapter of the runbook: its content shows where it is, with the error.
  if (index === undefined) {
    return (
      <>
        {errorBox}
        <ProgressRegistryContext.Provider value={registry}>
          {children}
        </ProgressRegistryContext.Provider>
      </>
    )
  }

  const label = name || `Chapter ${index + 1}`
  return (
    <section
      ref={sectionRef}
      {...{ [CHAPTER_INDEX_ATTRIBUTE]: index }}
      hidden={!isCurrent}
      aria-label={label}
      tabIndex={-1}
      className="outline-none"
    >
      {/* One chapter is a runbook in one piece, with nowhere to move to. */}
      {isCurrent && chapters.length > 1 && <ChapterBar />}
      {errorBox}
      <ProgressRegistryContext.Provider value={registry}>
        {children}
      </ProgressRegistryContext.Provider>
      {isCurrent && chapters.length > 1 && <ChapterPager />}
    </section>
  )
}

/** The nearest ancestor of `element` that scrolls vertically. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let el = element.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === "auto" || overflowY === "scroll") return el
  }
  return null
}
