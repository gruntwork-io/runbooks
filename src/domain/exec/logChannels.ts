/**
 * Log files for scripts.
 *
 * Every run gets log files named by environment variables, the way
 * RUNBOOK_OUTPUT names the outputs file:
 *
 *  - RUNBOOK_LOG: the log_* helpers append every line here, whatever its
 *    level. One file keeps the lines in the order the script wrote them.
 *    Each line names its own level, so it is shown as written.
 *  - RUNBOOK_INFO_LOG, RUNBOOK_WARN_LOG, RUNBOOK_ERROR_LOG, RUNBOOK_DEBUG_LOG:
 *    one per level, for lines that don't name one, such as a tool's stderr
 *    (`tofu plan 2>>"$RUNBOOK_ERROR_LOG"`). Each line gets the file's level.
 *
 * Any command, or a script in another language, can append to them. Nothing
 * written there touches stdout, so it never ends up in a `$(...)` capture.
 * The spawner follows the files while the script runs, so their lines reach
 * the log view and exec.log live.
 */

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG"

export interface LogChannel {
  /**
   * The level a line in the file gets when it doesn't already have the
   * helpers' prefix, or null for a file whose lines are shown as written.
   */
  readonly level: LogLevel | null
  /** Environment variable that holds the file's path. */
  readonly envVar: string
  /** File name inside the run's log directory. */
  readonly fileName: string
}

/** A per-level file: every line in it is shown at `level`. */
export interface LevelLogChannel extends LogChannel {
  readonly level: LogLevel
}

/** The file the log_* helpers append to. Its lines name their own level. */
export const RUNBOOK_LOG_CHANNEL: LogChannel = {
  level: null,
  envVar: "RUNBOOK_LOG",
  fileName: "runbook.log",
}

/** One file per level, for lines that don't name one. */
export const LEVEL_LOG_CHANNELS: readonly LevelLogChannel[] = [
  { level: "INFO", envVar: "RUNBOOK_INFO_LOG", fileName: "info.log" },
  { level: "WARN", envVar: "RUNBOOK_WARN_LOG", fileName: "warn.log" },
  { level: "ERROR", envVar: "RUNBOOK_ERROR_LOG", fileName: "error.log" },
  { level: "DEBUG", envVar: "RUNBOOK_DEBUG_LOG", fileName: "debug.log" },
]

/**
 * Every log file a run gets. RUNBOOK_LOG comes first, so when lines turn up
 * in several files at once, the helpers' lines are read first.
 */
export const LOG_CHANNELS: readonly LogChannel[] = [RUNBOOK_LOG_CHANNEL, ...LEVEL_LOG_CHANNELS]

/** `channels`, each with its file's path inside `dir`. */
export const logChannelFiles = <C extends LogChannel>(dir: string, channels: readonly C[]) =>
  channels.map((channel) => ({ ...channel, path: `${dir}/${channel.fileName}` }))

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
 * A line with the helpers' prefix already names its level, so it passes
 * through, as does a blank line. Any other line was written straight to the
 * file, so it gets the helpers' prefix with the file's level:
 * `[<at>] [ERROR] <line>`. The log view's parser (web/src/lib/logs.ts) then
 * files it under that level, even when the line itself starts with something
 * in brackets. `at` is when Runbooks read the line; without it the prefix is
 * only `[ERROR] `.
 */
export function tagLogLine(line: string, level: LogLevel, at?: Date): string {
  if (line.trim() === "" || HELPER_PREFIX.test(line)) return line
  const tag = `[${level}]`.padEnd("[ERROR] ".length)
  return at ? `[${logTimestamp(at)}] ${tag}${line}` : `${tag}${line}`
}

/**
 * Every line in a finished run's per-level log files, tagged, in one list.
 * For a reader that only gets the files after the script has exited (the
 * test CLI runs scripts with spawnSync), so it can't order them by arrival.
 *
 * Each file keeps its own order. Across files, lines are ordered by time, to
 * the second: a line with the helpers' prefix by its timestamp, and a line
 * without one with the next such line in its file, since it was written
 * before it. After the last such line (or in a file with none, the usual
 * case), lines sort at `lastWritten`, the file's modification time, or with
 * the last timestamped line if that isn't known. Lines from the same second
 * keep the INFO, WARN, ERROR, DEBUG order of LEVEL_LOG_CHANNELS.
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
    // Lines after the last timestamped line have no next one.
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
