/**
 * Where the engine located a problem in a runbook, as the window says it:
 * its line, and its file when that is not the runbook, from the runbook's
 * folder.
 */
import type { DocumentView } from "@runbooks/core/protocol"

type Location = DocumentView["warnings"][number]["location"]

export function place({ file, span }: Location, runbook: string): string {
  const line = span.start.line
  if (file === runbook) return `Line ${line}`
  const folder = runbook.slice(0, Math.max(runbook.lastIndexOf("/"), runbook.lastIndexOf("\\")) + 1)
  return `${file.startsWith(folder) ? file.slice(folder.length) : file}, line ${line}`
}
