import { useEffect, useState } from "react"
import { useApiExec, type FinishedStatus } from "@/hooks/useApiExec"
import { useExecutableRegistry } from "@/hooks/useExecutableRegistry"
import { useLogs } from "@/contexts/useLogs"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import type { OutputValues } from "@/lib/outputValues"
import { restoreRun, runEnded, runStarted } from "@/lib/sessionHistory"
import { createAppError, type AppError } from "@/types/error"

/**
 * The outputs a check publishes for other blocks. A failed check's outputs
 * only say what it found, so it publishes none, and a block that reads them
 * waits, as it does for a failed <Check>.
 */
function publishedOutputs(outputs: OutputValues | null, status: FinishedStatus): OutputValues {
  return status === "fail" ? {} : (outputs ?? {})
}

/**
 * Runs a <Prerequisites> block's check in the main process, and keeps its last
 * run in the session's history, as useScriptExecution does for a script.
 */
export function usePrerequisitesRun(componentId: string) {
  const { getExecutableByComponentId } = useExecutableRegistry()
  const { registerOutputs } = useRunbookContext()
  const { registerLogs } = useLogs()
  const history = useSessionHistory()

  // The block's last run, from the session's history. Resuming the session
  // doesn't check again: checking runs tools, which only a click does.
  const [restoredRun] = useState(() => restoreRun(history.saved(componentId, "run")))
  useEffect(() => {
    const status = restoredRun?.status
    if (status === "success" || status === "warn" || status === "fail") {
      registerOutputs(componentId, publishedOutputs(restoredRun!.outputs, status))
    }
  }, [restoredRun, componentId, registerOutputs])

  const { state, execute, cancel } = useApiExec({
    initialState: restoredRun,
    onFinished: (outputs, status) =>
      registerOutputs(componentId, publishedOutputs(outputs, status)),
    onRunStarted: () => history.record(componentId, "run", runStarted()),
    onRunEnded: (ended) => history.record(componentId, "run", runEnded(ended)),
  })

  useEffect(() => {
    registerLogs(componentId, state.logs)
  }, [componentId, state.logs, registerLogs])

  // Stop a check that is still running when the block goes away.
  useEffect(() => () => cancel(), [cancel])

  const [notRegistered, setNotRegistered] = useState<AppError | null>(null)
  const check = () => {
    const executable = getExecutableByComponentId(componentId)
    if (!executable) {
      setNotRegistered(
        createAppError(
          `Runbooks has no tool list for "${componentId}"`,
          "The runbook may have changed since it was opened. Close and reopen it (if Runbooks was started with --disable-live-file-reload, quit and restart the app instead).",
        ),
      )
      return
    }
    setNotRegistered(null)
    execute(executable.id)
  }

  return { state, check, cancel, error: notRegistered ?? state.error }
}
