import { useCallback, useRef, useState } from "react"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { parseSavedForm, type SavedForm } from "@/lib/sessionHistory"

interface UseFormHistoryReturn {
  /** What the form was left as, to start it from. Undefined when the history has nothing for it. */
  saved: SavedForm | undefined
  /**
   * Report the form's values and whether it is submitted. Call it with what
   * the form starts from, then on every change. The first call adds nothing
   * to the history. A later one adds an event when `submitted` or one of
   * `values` differs from what was last reported for it.
   *
   * A value that is no longer reported is not a change: a Template leaves out
   * the variables it imports, and which those are is settled only once the
   * blocks it imports from have mounted.
   */
  noteValues: (values: Record<string, unknown>, submitted: boolean) => void
}

/** What noteValues was last called with. Each value is kept as JSON, to compare by content. */
interface NotedForm {
  values: Record<string, string | undefined>
  submitted: boolean
}

/** Keeps the form of block `id` in the session's history. */
export function useFormHistory(id: string): UseFormHistoryReturn {
  const history = useSessionHistory()
  const [saved] = useState(() => parseSavedForm(history.saved(id, "inputs")))
  const lastNotedRef = useRef<NotedForm | null>(null)

  const noteValues = useCallback(
    (values: Record<string, unknown>, submitted: boolean) => {
      const noted = Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name, JSON.stringify(value)]),
      )
      const previous = lastNotedRef.current
      lastNotedRef.current = { values: { ...previous?.values, ...noted }, submitted }
      if (previous === null) return

      const changed =
        previous.submitted !== submitted ||
        Object.entries(noted).some(([name, value]) => previous.values[name] !== value)
      if (changed) history.record(id, "inputs", { values, submitted } satisfies SavedForm)
    },
    [history, id],
  )

  return { saved, noteValues }
}
