/**
 * Command: runs a script, written in its `command` prop or in the file its
 * `path` names, and ends by the script's exit code (`endWithExitCode`).
 *
 * - The script is the text the runbook was trusted with: a file is the one
 *   the engine read and hashed when the runbook opened, never read again.
 * - It runs with the run's environment and nothing else: the base, then
 *   each `envFrom` source, then `env`, then the variables Runbooks sets.
 *   It starts in the run's folder, with nothing on standard input.
 * - Its outputs go to `$RUNBOOK_OUTPUT`, the variables it gives the blocks
 *   that name it in `envFrom` to `$RUNBOOK_ENV`. The engine reads both once
 *   it ends well. Only the outputs its `outputs` prop declares are kept.
 * - It runs as written (`scripts`): a value reaches it only through `env`,
 *   and a `{{ }}` in it is text, as another tool's is.
 * - A bash or sh script runs under bash with the `log_*` helpers, which
 *   write to `$RUNBOOK_LOG`. Each level has a file of its own as well
 *   (`$RUNBOOK_INFO_LOG` and so on). Runbooks shows their lines as it shows
 *   standard error.
 * - Of a line it prints, the run keeps no more than a log line holds
 *   (`LIMITS.maxLogLineLength`), and counts the rest, which the log says
 *   was cut.
 * - With `exclusive`, it runs alone: the engine starts no other block
 *   that runs commands while it runs, and does not start it while one runs.
 * - It is stopped, with every process it started, when it is cancelled or
 *   runs past `timeoutMs`. Its folder (the script, the helpers, the log
 *   files) goes once they have ended, so a TERM trap can still use it.
 */
import { Effect, Redacted, Schema, Stream } from "effect"
import {
  BlockId,
  defineTask,
  endWithExitCode,
  RunbookPath,
  type RunEnv,
  type TaskEvent,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import { shellQuote } from "@runbooks/core/domain/exec/blockEnv"
import { LOG_CHANNELS, logChannelFiles, tagLogLine } from "@runbooks/core/domain/exec/logChannels"
import { LOGGING_FUNCTIONS, resolveScriptRunner } from "@runbooks/core/domain/exec/script"
import { LIMITS } from "@runbooks/core/protocol"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { type CutLine, linesCut, ProcessSpawner } from "@runbooks/core/services/ProcessSpawner"

/** How long a script may run when `timeoutMs` does not say: an hour. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

/** An output's name, as `$RUNBOOK_OUTPUT` and a template reference take it. */
const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const CommandProps = Schema.Struct({
  /** The script itself. */
  command: Schema.optionalKey(Schema.String),
  /** A script file in the runbook's folder. */
  path: Schema.optionalKey(RunbookPath),
  /** The outputs the script writes to `$RUNBOOK_OUTPUT` (open decision 8). */
  outputs: Schema.optionalKey(
    Schema.Array(
      Schema.String.check(
        Schema.isPattern(OUTPUT_NAME, {
          message: "an output's name is letters, digits and `_`, and does not start with a digit",
        }),
      ),
    ),
  ),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * It runs alone (`TaskBlock.exclusive`): no other block that runs
   * commands starts while it runs, and it does not start while one runs.
   */
  exclusive: Schema.optionalKey(Schema.Boolean),
  /**
   * The block that makes the repository the script starts in, and that
   * `$REPO_FILES` names. A block that works in a repository names it.
   */
  repository: Schema.optionalKey(BlockId),
  /** Shown by the view. */
  successMessage: Schema.optionalKey(Schema.String),
  failMessage: Schema.optionalKey(Schema.String),
  runningMessage: Schema.optionalKey(Schema.String),
}).check(
  Schema.makeFilter((p) => {
    if (p.command !== undefined && p.path !== undefined)
      return { path: ["path"], issue: "set `command` or `path`, not both" }
    if (p.command === undefined && p.path === undefined)
      return {
        path: ["command"],
        issue: "set `command`, the script itself, or `path`, a script file in the runbook's folder",
      }
    return undefined
  }),
)
type CommandProps = typeof CommandProps.Type

/** The script as the runbook was trusted with it. */
const scriptOf = (p: CommandProps, files: ReadonlyMap<string, string>): string | undefined =>
  p.command ?? (p.path === undefined ? undefined : files.get(p.path))

/** What a script is written in: the interpreter it runs with, which its shebang names, bash when it names none. */
const languageOf = (script: string): string => resolveScriptRunner(script, "").interpreter

const revealed = (env: RunEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([name, value]) => [name, Redacted.value(value)]))

const toEvent = ({ line, source, cut }: CutLine): TaskEvent<string> => ({
  _tag: "Log",
  // A log file's lines are the helpers', which write to standard error when it is unset.
  stream: source === "stdout" ? "stdout" : "stderr",
  line,
  cut,
})

/**
 * A failure in Runbooks' own work before the script starts, said as what
 * could not be done and the error's code (ENOENT, E2BIG), never its message:
 * a spawn error's message can quote the environment, which holds the
 * script's values.
 */
const couldNot = (what: string) => (error: { readonly _tag: string; readonly cause?: unknown }) =>
  new TaskFailed({ message: `Runbooks could not ${what}: ${codeOf(error.cause) ?? error._tag}.` })

const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined

export const command = defineTask({
  name: "Command",
  since: "0.1.0",
  class: "task",
  props: CommandProps,
  children: { kind: "markdown" },
  references: { repository: "repository" },
  runbookFiles: (p) => (p.path === undefined ? [] : [p.path]),
  scripts: (p) =>
    p.command !== undefined
      ? [{ _tag: "Prop", prop: "command" }]
      : p.path !== undefined
        ? [{ _tag: "File", path: p.path }]
        : [],
  scriptLanguage: (_p, script) => languageOf(script),
  timeLimit: (p) => p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  exclusive: (p) => p.exclusive === true,
  provides: ["run", "env"],
  effects: ["process"],
  outputs: (p) => Object.fromEntries((p.outputs ?? []).map((name) => [name, { sensitive: false }])),
  run: (p, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const script = scriptOf(p, input.files)
        const source = p.path ?? "The command"
        if (script === undefined)
          return yield* new TaskFailed({
            message: `${source} was not read when the runbook opened, so it cannot run.`,
          })
        const runner = resolveScriptRunner(script, "")

        const fs = yield* FileSystem
        const folder = yield* Effect.acquireRelease(fs.mkdtemp("runbooks-command-"), (made) =>
          Effect.ignore(fs.rm(made, { recursive: true, force: true })),
        ).pipe(Effect.mapError(couldNot("make a folder for the script")))
        const scriptFile = `${folder}/script`
        const logs = logChannelFiles(folder, LOG_CHANNELS)
        const helpers = `${folder}/helpers.sh`
        // Sourced on the script's first line, so its line numbers stay its own.
        const text = runner.wrap ? `. ${shellQuote(helpers)}; ${script}` : script
        yield* Effect.all(
          [
            fs.writeFile(scriptFile, text),
            ...(runner.wrap ? [fs.writeFile(helpers, LOGGING_FUNCTIONS)] : []),
            ...logs.map((log) => fs.writeFile(log.path, "")),
          ],
          { discard: true },
        ).pipe(Effect.mapError(couldNot("write the script")))

        const spawner = yield* ProcessSpawner
        const running = yield* Effect.acquireRelease(
          spawner.spawn(runner.interpreter, [...runner.args, scriptFile], {
            cwd: input.cwd,
            env: {
              ...revealed(input.env),
              ...Object.fromEntries(logs.map((log) => [log.envVar, log.path])),
            },
            logChannels: logs.map((log) => ({
              path: log.path,
              formatLine:
                log.level === null ? undefined : (line) => tagLogLine(line, log.level!, new Date()),
            })),
          }),
          // Stops the script and every process it started, unless it has ended.
          (spawned) => spawned.kill,
        ).pipe(Effect.mapError(couldNot(`start ${runner.interpreter}`)))

        return Stream.concat(
          Stream.map(linesCut(running.output, LIMITS.maxLogLineLength), toEvent),
          Stream.unwrap(Effect.map(running.exitCode, endWithExitCode)),
        )
      }),
    ),
  // The old app's wording: "Run this command:" for an inline one, "Run this script:" for a file.
  instruction: (p, reads) => {
    const script = scriptOf(p, reads.files) ?? ""
    return [
      {
        kind: "text",
        markdown: p.command === undefined ? "Run this script:" : "Run this command:",
      },
      { kind: "code", language: languageOf(script), code: script },
    ]
  },
  plugins: [],
})
