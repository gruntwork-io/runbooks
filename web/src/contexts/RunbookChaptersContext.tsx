import { useMemo, useState, type ReactNode } from "react"
import {
  ChaptersControlContext,
  RunbookChaptersContext,
  type ChaptersControl,
  type RunbookChapters,
} from "./RunbookChaptersContext.types"

const NO_CHAPTERS: RunbookChapters = { chapters: [], current: 0, progress: [], navigation: 0 }

/**
 * Holds the open runbook's chapters (see the <Chapter> block) and which one
 * is on screen, for its chapters and the command palette. MDXContainer sets
 * the chapters each time the runbook compiles, and clears them when it
 * unmounts, as it does for another runbook or session, so those start at
 * their first chapter while a watch-mode reload stays where it was.
 */
export function RunbookChaptersProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RunbookChapters>(NO_CHAPTERS)

  const control = useMemo<ChaptersControl>(
    () => ({
      setChapters: (chapters) => {
        setState((prev) =>
          chapters.length === 0
            ? { ...NO_CHAPTERS, navigation: prev.navigation }
            : {
                chapters,
                current: Math.min(prev.current, chapters.length - 1),
                progress: prev.progress.slice(0, chapters.length),
                navigation: prev.navigation,
              },
        )
      },
      goTo: (index) => {
        setState((prev) =>
          index === prev.current || index < 0 || index >= prev.chapters.length
            ? prev
            : { ...prev, current: index, navigation: prev.navigation + 1 },
        )
      },
      show: (index) => {
        setState((prev) =>
          index === prev.current || index < 0 || index >= prev.chapters.length
            ? prev
            : { ...prev, current: index },
        )
      },
      reportProgress: (index, { total, done }) => {
        setState((prev) => {
          const reported = prev.progress[index]
          if (index < 0 || index >= prev.chapters.length) return prev
          if (reported?.total === total && reported.done === done) return prev
          const progress = [...prev.progress]
          progress[index] = { total, done }
          return { ...prev, progress }
        })
      },
    }),
    [],
  )

  return (
    <ChaptersControlContext.Provider value={control}>
      <RunbookChaptersContext.Provider value={state}>{children}</RunbookChaptersContext.Provider>
    </ChaptersControlContext.Provider>
  )
}
