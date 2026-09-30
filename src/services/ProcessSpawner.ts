import { Context, Effect, Stream } from "effect"
import type { Cause } from "effect"
import type { SpawnError } from "../errors/index.ts"

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
  /**
   * When set, combined stdout/stderr lines are appended to this file (in arrival
   * order) as the process runs, producing a durable, tailable log on disk. The
   * file is written in parallel with the `output` stream; both reflect the same
   * data. The caller owns the file's lifecycle (creation and cleanup).
   */
  readonly logFilePath?: string
  /**
   * Files the child appends log lines to as it runs (a script's per-level log
   * files). The spawner follows each one and adds its lines to `output` and
   * `logFilePath` as they are written, with source "file". Their order
   * relative to stdout and stderr is best effort. Before `output` ends, each
   * file is read to the end, including a last line with no newline. The
   * caller owns the files' lifecycle (creation and cleanup).
   */
  readonly logChannels?: ReadonlyArray<SpawnLogChannel>
}

export interface SpawnLogChannel {
  readonly path: string
  /** Maps each line read from the file to the line to emit, e.g. to tag its level. */
  readonly formatLine?: (line: string) => string
}

export interface OutputLine {
  readonly line: string
  /** "file" lines come from one of SpawnOptions.logChannels. */
  readonly source: "stdout" | "stderr" | "file"
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

export class ProcessSpawner extends Context.Tag("ProcessSpawner")<ProcessSpawner, ProcessSpawnerShape>() {}

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
): Effect.Effect<CollectedOutput, Cause.TimeoutException> =>
  Effect.gen(function* () {
    const lines: OutputLine[] = []
    yield* proc.output.pipe(
      Stream.runForEach((line) => Effect.sync(() => lines.push(line))),
      Effect.timeout(timeoutMs),
    )
    const exitCode = yield* proc.exitCode.pipe(Effect.timeout(timeoutMs))
    return { exitCode, lines }
  }).pipe(Effect.ensuring(proc.kill.pipe(Effect.ignore)))
