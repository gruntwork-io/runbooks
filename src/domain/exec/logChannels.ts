/**
 * Per-level log files for scripts.
 *
 * Every run gets one file per log level, named by an environment variable the
 * way RUNBOOK_OUTPUT names the outputs file. The injected log_* helpers append
 * to them, and so can any command (`tofu plan 2>>"$RUNBOOK_ERROR_LOG"`) or a
 * script in another language. Nothing written there touches stdout, so it
 * never ends up in a `$(...)` capture. The spawner follows the files while
 * the script runs, so their lines reach the log view and exec.log live.
 */

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG"

export interface LogChannel {
  readonly level: LogLevel
  /** Environment variable that holds the file's path. */
  readonly envVar: string
  /** File name inside the run's log directory. */
  readonly fileName: string
}

export const LOG_CHANNELS: readonly LogChannel[] = [
  { level: "INFO", envVar: "RUNBOOK_INFO_LOG", fileName: "info.log" },
  { level: "WARN", envVar: "RUNBOOK_WARN_LOG", fileName: "warn.log" },
  { level: "ERROR", envVar: "RUNBOOK_ERROR_LOG", fileName: "error.log" },
  { level: "DEBUG", envVar: "RUNBOOK_DEBUG_LOG", fileName: "debug.log" },
]

/** The channels, each with its file's path inside `dir`. */
export const logChannelFiles = (dir: string) =>
  LOG_CHANNELS.map((channel) => ({ ...channel, path: `${dir}/${channel.fileName}` }))

/**
 * The start of a line the helpers write: "[<UTC timestamp>] [<LEVEL>] ".
 * Group 1 is the timestamp.
 */
const HELPER_PREFIX = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\] \[(?:INFO|WARN|ERROR|DEBUG)\] /

/** A time in the helpers' format: ISO-8601 UTC, to the second. */
export const logTimestamp = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z")

/**
 * The line to show for `line`, read from `level`'s file.
 *
 * A helper's line already names its level, so it passes through, as does a
 * blank line. Any other line was written straight to the file, so it gets
 * the helpers' prefix with the file's level: `[<at>] [ERROR] <line>`. The log
 * view's parser (web/src/lib/logs.ts) then files it under that level, even
 * when the line itself starts with something in brackets. `at` is when
 * Runbooks read the line; without it the prefix is only `[ERROR] `.
 */
export function tagLogLine(line: string, level: LogLevel, at?: Date): string {
  if (line.trim() === "" || HELPER_PREFIX.test(line)) return line
  const tag = `[${level}]`.padEnd("[ERROR] ".length)
  return at ? `[${logTimestamp(at)}] ${tag}${line}` : `${tag}${line}`
}

/**
 * Every line in a finished run's log files, tagged, in one list. For a
 * reader that only gets the files after the script has exited (the test CLI
 * runs scripts with spawnSync), so it can't order them by arrival.
 *
 * Each file keeps its own order. Across files, lines are ordered by the
 * helpers' timestamps, which are to the second; lines from the same second
 * keep the INFO, WARN, ERROR, DEBUG order of LOG_CHANNELS. A line written
 * straight to a file has no timestamp: it sorts with the next helper line in
 * that file, since it was written before it. After the last helper line (or
 * in a file with none), lines sort at `lastWritten`, the file's modification
 * time, or with the last helper line if that isn't known.
 */
export function orderLogChannelLines(
  files: ReadonlyArray<{
    readonly level: LogLevel
    readonly text: string
    readonly lastWritten?: Date
  }>,
): string[] {
  const entries: { key: string; line: string }[] = []
  for (const { level, text, lastWritten } of files) {
    const lines = text.split("\n").map((line) => line.replace(/\r$/, ""))
    if (lines.at(-1) === "") lines.pop()
    const stamps = lines.map((line) => HELPER_PREFIX.exec(line)?.[1] ?? "")

    const keys: string[] = []
    let next = ""
    for (let i = lines.length - 1; i >= 0; i--) {
      next = stamps[i] || next
      keys[i] = next
    }
    // Lines after the last helper line have no next one.
    let previous = ""
    for (let i = 0; i < lines.length; i++) {
      previous = stamps[i] || previous
      if (keys[i] === "") keys[i] = lastWritten ? logTimestamp(lastWritten) : previous
      entries.push({ key: keys[i], line: tagLogLine(lines[i], level) })
    }
  }
  // Array.prototype.sort is stable, so equal keys keep file, then line, order.
  return entries
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.line)
}
