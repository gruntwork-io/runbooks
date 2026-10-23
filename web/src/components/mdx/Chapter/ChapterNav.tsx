import { ChevronDown, ChevronLeft, ChevronRight, CircleCheck, List } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ChapterInfo } from "@/contexts/RunbookChaptersContext.types"
import type { RunbookProgress } from "@/contexts/RunbookProgressContext.types"
import { useChaptersControl, useRunbookChapters } from "@/contexts/useRunbookChapters"
import { FIND_IGNORE_ATTRIBUTE } from "@/lib/findInPage"
import { cn } from "@/lib/utils"

/** A chapter's name, or its number for one without a title. */
export function chapterName(chapter: ChapterInfo | undefined, index: number): string {
  return chapter?.title || `Chapter ${index + 1}`
}

/** Whether all of a chapter's steps are done; never for a chapter without steps. */
function isDone(progress: RunbookProgress | undefined): boolean {
  return progress !== undefined && progress.total > 0 && progress.done === progress.total
}

// The bar and the pager are app chrome rather than runbook text, so find in
// page leaves them out, as it does the Header.
const findIgnore = { [FIND_IGNORE_ATTRIBUTE]: "" }

/**
 * The bar at the top of the chapter on screen, which stays in view as the
 * chapter scrolls: the table of contents, which chapter this is, and buttons
 * to the previous and next chapters. A sticky element sticks inside its
 * scroller's padding, so it sticks --runbook-padding higher, at the top edge,
 * where no text can scroll by above it.
 */
export function ChapterBar() {
  const { chapters, current } = useRunbookChapters()
  const { goTo } = useChaptersControl()
  const previous = current > 0 ? current - 1 : undefined
  const next = current < chapters.length - 1 ? current + 1 : undefined

  return (
    <nav
      aria-label="Chapters"
      {...findIgnore}
      className="sticky top-[calc(var(--runbook-padding,0px)*-1)] z-10 mb-6 flex items-center gap-1 rounded-lg border border-border bg-bg-default/95 p-1 shadow-sm backdrop-blur-sm"
    >
      <ChapterContents />
      <div
        data-testid="chapter-bar-position"
        className="min-w-0 flex-1 truncate px-2 text-sm text-muted-foreground"
      >
        <span className="tabular-nums">{`Chapter ${current + 1} of ${chapters.length}`}</span>
        <span aria-hidden> · </span>
        <span className="font-medium text-foreground">
          {chapterName(chapters[current], current)}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={previous === undefined}
        aria-label={
          previous === undefined
            ? "Previous chapter"
            : `Previous chapter: ${chapterName(chapters[previous], previous)}`
        }
        title="Previous chapter"
        onClick={() => previous !== undefined && goTo(previous)}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={next === undefined}
        aria-label={
          next === undefined ? "Next chapter" : `Next chapter: ${chapterName(chapters[next], next)}`
        }
        title="Next chapter"
        onClick={() => next !== undefined && goTo(next)}
      >
        <ChevronRight />
      </Button>
    </nav>
  )
}

/**
 * The table of contents: a menu of the runbook's chapters, with how many of
 * each one's steps are done, that goes to the chapter picked.
 */
function ChapterContents() {
  const { chapters, current, progress } = useRunbookChapters()
  const { goTo } = useChaptersControl()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5">
          <List />
          Contents
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        aria-label="Table of contents"
      >
        {chapters.map((chapter, index) => {
          const steps = progress[index]
          const done = isDone(steps)
          return (
            <DropdownMenuItem
              // Chapters are only ever listed in order, so the index is stable.
              key={index}
              aria-current={index === current ? "page" : undefined}
              className={cn("gap-3", index === current && "bg-accent/60 font-medium")}
              onSelect={() => goTo(index)}
            >
              {done ? (
                <CircleCheck aria-label="Done" className="text-success" />
              ) : (
                <span className="w-4 text-center text-xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{chapterName(chapter, index)}</span>
              {steps !== undefined && steps.total > 0 && (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    done ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {`${steps.done}/${steps.total}`}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Links to the previous and next chapters, at the end of the chapter on screen. */
export function ChapterPager() {
  const { chapters, current } = useRunbookChapters()
  const { goTo } = useChaptersControl()
  const previous = current > 0 ? current - 1 : undefined
  const next = current < chapters.length - 1 ? current + 1 : undefined

  const linkClass =
    "group flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-lg border border-border px-4 py-3 transition-colors hover:bg-accent"
  return (
    <nav
      aria-label="Chapter pages"
      {...findIgnore}
      className="mt-10 flex gap-3 border-t border-border pt-6"
    >
      {previous === undefined ? (
        <span className="flex-1" />
      ) : (
        <button type="button" className={cn(linkClass, "text-left")} onClick={() => goTo(previous)}>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronLeft className="size-3.5" />
            Previous
          </span>
          <span className="truncate font-medium">{chapterName(chapters[previous], previous)}</span>
        </button>
      )}
      {next === undefined ? (
        <span className="flex-1" />
      ) : (
        <button type="button" className={cn(linkClass, "text-right")} onClick={() => goTo(next)}>
          <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
            Next
            <ChevronRight className="size-3.5" />
          </span>
          <span className="truncate font-medium">{chapterName(chapters[next], next)}</span>
        </button>
      )}
    </nav>
  )
}
