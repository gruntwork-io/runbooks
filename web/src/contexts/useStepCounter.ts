import { useMemo, useState } from "react"
import type { ProgressRegistry, RunbookProgress } from "./RunbookProgressContext.types"

/**
 * Counts the steps that report to the registry it returns, and how many of
 * them are done. With `parent`, each report goes on to it as well, so a part
 * of the runbook, such as a chapter, can count its own steps while they still
 * count toward the whole runbook's.
 */
export function useStepCounter(parent?: ProgressRegistry): [RunbookProgress, ProgressRegistry] {
  // Whether each mounted step is done, keyed by the step's useId()
  const [steps, setSteps] = useState<Readonly<Record<string, boolean>>>({})

  const registry = useMemo<ProgressRegistry>(
    () => ({
      reportStep: (key, done) => {
        parent?.reportStep(key, done)
        setSteps((prev) => (prev[key] === done ? prev : { ...prev, [key]: done }))
      },
      removeStep: (key) => {
        parent?.removeStep(key)
        setSteps((prev) => {
          if (!(key in prev)) return prev
          const { [key]: _removed, ...rest } = prev
          return rest
        })
      },
    }),
    [parent],
  )

  const states = Object.values(steps)
  const total = states.length
  const done = states.filter(Boolean).length
  const progress = useMemo(() => ({ total, done }), [total, done])

  return [progress, registry]
}
