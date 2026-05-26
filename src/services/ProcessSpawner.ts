import { Context, Effect, Stream } from "effect"
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
}

export interface OutputLine {
  readonly line: string
  readonly source: "stdout" | "stderr"
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
