import { Context, Effect, Stream } from "effect"
import type { Cause } from "effect"
import type { SpawnError } from "../errors/index.ts"

export interface SpawnOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string | undefined
  readonly windowsVerbatimArguments?: boolean | undefined
  /**
   * When set, combined stdout/stderr lines are appended to this file (in arrival
   * order) as the process runs, producing a durable, tailable log on disk. The
   * file is written in parallel with the `output` stream; both reflect the same
   * data. The caller owns the file's lifecycle (creation and cleanup).
   */
  readonly logFilePath?: string
  /**
   * Files the child appends log lines to as it runs (a script's log files).
   * The spawner follows each one and adds its lines to `output` and
   * `logFilePath` as they are written, with source "file". Each file's lines
   * keep their order. Across files, and relative to stdout and stderr, the
   * order is best effort: lines that reach several files between two reads
   * come out grouped by file, in the order the files are given. Before
   * `output` ends, each file is read to the end, including a last line with
   * no newline. The caller owns the files' lifecycle (creation and cleanup).
   */
  readonly logChannels?: ReadonlyArray<SpawnLogChannel>
}

export interface SpawnLogChannel {
  readonly path: string
  /** Maps each line read from the file to the line to emit, e.g. to tag its level. */
  readonly formatLine?: ((line: string) => string) | undefined
}

export interface OutputLine {
  readonly line: string
  /** "file" lines come from one of SpawnOptions.logChannels. */
  readonly source: "stdout" | "stderr" | "file"
  /**
   * The line goes on in the next piece from the same source. A stdout or
   * stderr line longer than the spawner holds whole comes in pieces, each but
   * the last marked so. `wholeLines` and `collectOutput` join them; a reader
   * that shows lines may show each piece as one.
   */
  readonly continues?: true
}

export interface SpawnedProcess {
  readonly output: Stream.Stream<OutputLine>
  readonly exitCode: Effect.Effect<number>
  readonly kill: Effect.Effect<void>
}

export interface ProcessSpawnerShape {
  readonly spawn: (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => Effect.Effect<SpawnedProcess, SpawnError>
}

export class ProcessSpawner extends Context.Service<ProcessSpawner, ProcessSpawnerShape>()(
  "ProcessSpawner",
) {}

/**
 * `output` with each line that came in pieces joined, for a reader that
 * parses what the process wrote. A whole line comes when its last piece
 * does, so it may follow lines from the other source that came between its
 * pieces.
 */
export const wholeLines = <E, R>(
  output: Stream.Stream<OutputLine, E, R>,
): Stream.Stream<OutputLine, E, R> =>
  output.pipe(
    Stream.mapAccum(
      (): ReadonlyMap<OutputLine["source"], string> => new Map(),
      (started, piece) => {
        const before = started.get(piece.source) ?? ""
        const next = new Map(started)
        if (piece.continues) {
          next.set(piece.source, before + piece.line)
          return [next, []] as const
        }
        next.delete(piece.source)
        return [next, [{ line: before + piece.line, source: piece.source }]] as const
      },
      {
        // A process that ends mid-line: its last piece is not marked, so
        // nothing is left here unless output was cut short.
        onHalt: (started) => [...started].map(([source, line]) => ({ line, source })),
      },
    ),
  )

/** Everything a short-lived process wrote, in arrival order, plus its exit code. */
export interface CollectedOutput {
  readonly exitCode: number
  readonly lines: OutputLine[]
}

/**
 * Drain a spawned process's combined output, then await its exit code, each
 * bounded by `timeoutMs`. The process is killed however this ends (success,
 * timeout, or interruption), so a hung CLI can never outlive its reader.
 * Callers keep their own spawn (argv, env) and error mapping; filter `lines`
 * by `source` to split stdout from stderr.
 */
export const collectOutput = (
  proc: SpawnedProcess,
  timeoutMs: number,
): Effect.Effect<CollectedOutput, Cause.TimeoutError> =>
  Effect.gen(function* () {
    const lines: OutputLine[] = []
    yield* wholeLines(proc.output).pipe(
      Stream.runForEach((line) => Effect.sync(() => lines.push(line))),
      Effect.timeout(timeoutMs),
    )
    const exitCode = yield* proc.exitCode.pipe(Effect.timeout(timeoutMs))
    return { exitCode, lines }
  }).pipe(Effect.ensuring(proc.kill.pipe(Effect.ignore)))
