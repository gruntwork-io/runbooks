import { ViewLogs } from "@/components/mdx/_shared/components/ViewLogs"
import type { ExecutionStatus } from "@/components/mdx/_shared/types"
import type { LogEntry } from "@/hooks/useApiExec"
import type { LogLine } from "../runMachine"

const COLOR = { error: "\x1b[31m", warn: "\x1b[33m" } as const
const RESET = "\x1b[0m"

/** A log line as the shared log view takes it, with its level as a terminal color. */
export function logEntry({ line, level, at }: LogLine): LogEntry {
  return { line: level ? `${COLOR[level]}${line}${RESET}` : line, timestamp: at }
}

/**
 * A run's log in the shared log view, open while the run goes so its output
 * is visible from the first line. Nothing shows before a run starts.
 */
export function RunLog({
  blockId,
  log,
  status,
}: {
  blockId: string
  log: readonly LogLine[]
  status: ExecutionStatus
}) {
  const running = status === "running"
  if (log.length === 0 && !running) return null
  return <ViewLogs logs={log.map(logEntry)} status={status} autoOpen={running} blockId={blockId} />
}
