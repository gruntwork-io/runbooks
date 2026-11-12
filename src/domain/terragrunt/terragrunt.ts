/**
 * Runs Terragrunt for a <TerragruntApply> block's unit, streaming OpenTofu's
 * events and Terragrunt's own log lines as they come.
 *
 * Interrupting a run signals Terragrunt's whole process tree, then keeps
 * reading its output until it exits, so OpenTofu can finish the resource it's
 * on and release the state lock, the block sees everything it did, and
 * nothing outlives the run.
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner, type OutputLine } from "../../services/ProcessSpawner.ts"
import { TfModuleError, type SpawnError } from "../../errors/index.ts"
import { commandLine, uiEvents, type RunEvent } from "./run.ts"

export const TERRAGRUNT_INSTALL = "https://terragrunt.gruntwork.io/docs/getting-started/install/"

const fail = (message: string) => new TfModuleError({ message })

export interface ToolRun {
  readonly cwd: string
  /** Where Terragrunt downloads the module and runs OpenTofu. */
  readonly downloadDir?: string
  readonly env: Record<string, string>
  /** Called with each event from OpenTofu's `-json` output; without it, stdout is collected. */
  readonly onEvent?: (event: RunEvent) => void
  /** Called with the tool's own log lines. */
  readonly onLog?: (event: RunEvent) => void
}

/** A Terragrunt or OpenTofu log line without its time, and its level. */
export function toolLog(line: string): RunEvent | undefined {
  const plain = line.trimEnd()
  if (!plain.trim()) return undefined
  const match = /^\d\d:\d\d:\d\d\.\d+\s+(\w+)\s+(.*)$/.exec(plain)
  // OpenTofu's own errors have no level, only an "Error:" heading.
  const level = match?.[1] ?? (/^[\s│╷]*Error:/.test(plain) ? "ERROR" : undefined)
  return {
    kind: "log",
    line: match ? match[2]! : plain,
    ...(level === "ERROR" ? { level: "error" } : level === "WARN" ? { level: "warn" } : {}),
  }
}

const spawnFailure = (err: SpawnError) => {
  const cause = err.cause as NodeJS.ErrnoException | undefined
  if (cause?.code === "ENOENT") {
    return fail(
      `Runbooks runs this Terragrunt unit with Terragrunt, which isn't on your PATH. Install it: ${TERRAGRUNT_INSTALL}`,
    )
  }
  return fail(`Couldn't run Terragrunt: ${cause instanceof Error ? cause.message : String(cause)}`)
}

/**
 * Runs Terragrunt in a block's unit, failing with its last error lines when
 * it exits with anything but 0, a signal included. Returns stdout when
 * there's no `onEvent`. Terragrunt initializes as it goes.
 */
export const runTerragrunt = (subcommand: readonly string[], run: ToolRun) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const command = "terragrunt"
    const args = [...subcommand, "--non-interactive", "--no-color"]
    if (run.downloadDir) args.push("--download-dir", run.downloadDir)
    // The command first, so a run that prints nothing for a while still shows
    // what it's waiting on, in a form that can be run again in a terminal.
    run.onLog?.({ kind: "log", line: commandLine(run.cwd, command, args) })
    const proc = yield* spawner
      .spawn(command, args, { cwd: run.cwd, env: run.env })
      .pipe(Effect.mapError(spawnFailure))

    let stdout = ""
    const errors: string[] = []
    const handle = ({ line, source }: OutputLine) =>
      Effect.sync(() => {
        if (source === "stderr") {
          const event = toolLog(line)
          if (!event) return
          if (event.kind === "log" && event.level === "error") errors.push(event.line)
          run.onLog?.(event)
          return
        }
        if (!run.onEvent) {
          stdout += `${line}\n`
          return
        }
        for (const event of uiEvents(line)) {
          if (event.kind === "log" && event.level === "error") errors.push(event.line)
          run.onEvent(event)
        }
      })
    const toExit = proc.output.pipe(Stream.runForEach(handle), Effect.andThen(proc.exitCode))
    const code = yield* toExit.pipe(
      Effect.onInterrupt(() => Effect.andThen(proc.kill, toExit.pipe(Effect.ignore))),
    )
    if (code !== 0) {
      return yield* fail(errors.slice(-3).join(" ") || `Terragrunt exited with code ${code}.`)
    }
    return stdout
  })
