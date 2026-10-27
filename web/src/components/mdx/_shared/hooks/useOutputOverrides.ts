import { useState } from "react"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { overridesChanged, restoreOverrides } from "@/lib/sessionHistory"
import type { OutputValue, TemplateOutputs } from "@/lib/templateUtils"
import { overridesFor, withOverride, type OutputRef } from "../lib/outputOverrides"

export interface UseOutputOverridesReturn {
  /** The values entered for the outputs in `refs`, by block and output. */
  overrides: TemplateOutputs
  /** Use `value` for the output in place of what its block outputs. */
  setOverride: (ref: OutputRef, value: OutputValue) => void
  /** Go back to what the output's block outputs. */
  resetOverride: (ref: OutputRef) => void
}

/**
 * The outputs a script block was given by hand (see lib/outputOverrides.ts).
 * They're kept in the session's history, so a resumed session still has them.
 * Only the ones for `refs`, the outputs the block's env still reads, apply:
 * one the runbook no longer reads is kept but ignored.
 */
export function useOutputOverrides(
  blockId: string,
  refs: ReadonlyMap<string, OutputRef>,
): UseOutputOverridesReturn {
  const history = useSessionHistory()
  const [entered, setEntered] = useState<TemplateOutputs>(() =>
    restoreOverrides(history.saved(blockId, "overrides")),
  )

  const change = (ref: OutputRef, value: OutputValue | undefined) => {
    const next = withOverride(entered, ref, value)
    setEntered(next)
    history.record(blockId, "overrides", overridesChanged(next))
  }

  return {
    overrides: overridesFor(entered, refs),
    setOverride: (ref, value) => change(ref, value),
    resetOverride: (ref) => change(ref, undefined),
  }
}
