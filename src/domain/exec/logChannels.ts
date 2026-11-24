/**
 * Log files for scripts.
 *
 * Every run gets one log file per level, named by an environment variable
 * the way RUNBOOK_OUTPUT names the outputs file: RUNBOOK_INFO_LOG,
 * RUNBOOK_WARN_LOG, RUNBOOK_ERROR_LOG and RUNBOOK_DEBUG_LOG. Each line a
 * script appends (`echo "Deploying" >>"$RUNBOOK_INFO_LOG"`, or
 * `tofu plan 2>>"$RUNBOOK_ERROR_LOG"`) is shown at the file's level.
 *
 * Any command, or a script in any language, can append to them. Nothing
 * written there touches stdout, so it never ends up in a `$(...)` capture.
 * The spawner follows the files while the script runs, so their lines reach
 * the log view and the run's log file live.
 */

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG"

export interface LogChannel {
  /** The level every line in the file is shown at. */
  readonly level: LogLevel
  /** Environment variable that holds the file's path. */
  readonly envVar: string
  /** File name inside the run's log directory. */
  readonly fileName: string
}

/** Every log file a run gets, one per level. */
export const LOG_CHANNELS: readonly LogChannel[] = [
  { level: "INFO", envVar: "RUNBOOK_INFO_LOG", fileName: "info.log" },
  { level: "WARN", envVar: "RUNBOOK_WARN_LOG", fileName: "warn.log" },
  { level: "ERROR", envVar: "RUNBOOK_ERROR_LOG", fileName: "error.log" },
  { level: "DEBUG", envVar: "RUNBOOK_DEBUG_LOG", fileName: "debug.log" },
]

/** `channels`, each with its file's path inside `dir`. */
export const logChannelFiles = (dir: string, channels: readonly LogChannel[]) =>
  channels.map((channel) => ({ ...channel, path: `${dir}/${channel.fileName}` }))

/** A time as log lines show it: ISO-8601 UTC, to the second. */
export const logTimestamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z")

/**
 * The line to show for `line`, read from `level`'s file at `at`:
 * `[<at>] [ERROR] <line>`. The log view's parser (web/src/lib/logs.ts) then
 * files it under that level, even when the line itself starts with something
 * in brackets. A blank line stays blank.
 */
export function tagLogLine(line: string, level: LogLevel, at: Date): string {
  if (line.trim() === "") return line
  return `[${logTimestamp(at)}] ${`[${level}]`.padEnd("[ERROR] ".length)}${line}`
}
