/**
 * Builds the text behind the log toolbar's "Copy prompt for LLM" button: a
 * ready-to-paste prompt that tells an LLM which runbook and step the logs come
 * from, where to find them, and what to do with them given the step's status.
 * Pure and framework-agnostic so it can be unit-tested directly.
 */

import type { ExecutionStatus } from "../types"

/**
 * How many trailing log lines are inlined when there is no log file to point
 * at. Keeps a pasted prompt manageable; errors are usually near the end.
 */
export const LLM_PROMPT_MAX_INLINE_LINES = 200

export interface LlmPromptArgs {
  blockId: string
  status: ExecutionStatus
  /** Local path to the runbook's .mdx file. */
  runbookFilePath?: string | undefined
  /** The URL the runbook was opened from, when it is a remote runbook. */
  remoteSource?: string | undefined
  /** On-disk log file (Command/Check runs). When set, the prompt references it instead of inlining logs. */
  logFilePath?: string | null | undefined
  /** The logs as plain text (ANSI already stripped), one entry per line. */
  logText: string
}

const INSTRUCTIONS: Record<ExecutionStatus, string> = {
  fail: "The step has failed. Analyze the failure and suggest steps for remediation to address the errors shown.",
  warn: "The step finished with warnings. Explain the warnings and suggest steps to address them.",
  success:
    "The step succeeded. Summarize what it did and point out anything in the logs that needs attention.",
  running:
    "The step is still running. Summarize its progress so far and point out any errors or warnings in the logs.",
  // No final status, e.g. logs left over from a cancelled run.
  pending: "Analyze the logs and point out any errors or warnings, with steps to address them.",
}

function describeRunbook(runbookFilePath?: string, remoteSource?: string): string {
  if (runbookFilePath) {
    const origin = remoteSource ? ` (opened from ${remoteSource})` : ""
    return `the Gruntwork Runbook ${runbookFilePath}${origin}`
  }
  if (remoteSource) return `the Gruntwork Runbook opened from ${remoteSource}`
  return "a Gruntwork Runbook"
}

/** A Markdown code fence longer than any backtick run in `text` (minimum three). */
function fenceFor(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  return "`".repeat(Math.max(3, longestRun + 1))
}

export function buildLlmPrompt({
  blockId,
  status,
  runbookFilePath,
  remoteSource,
  logFilePath,
  logText,
}: LlmPromptArgs): string {
  const step = `step \`${blockId}\` of ${describeRunbook(runbookFilePath, remoteSource)}`
  const instruction = INSTRUCTIONS[status]

  if (logFilePath) {
    return `The logs for ${step} are in this file:\n\n${logFilePath}\n\n${instruction}`
  }

  const lines = logText.split("\n")
  const kept = lines.slice(-LLM_PROMPT_MAX_INLINE_LINES).join("\n")
  const note =
    lines.length > LLM_PROMPT_MAX_INLINE_LINES
      ? `(Only the last ${LLM_PROMPT_MAX_INLINE_LINES} of ${lines.length} lines are shown.)\n\n`
      : ""
  const fence = fenceFor(kept)

  return `Here are the logs for ${step}:\n\n${note}${fence}\n${kept}\n${fence}\n\n${instruction}`
}
