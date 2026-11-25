/**
 * The `runbooks` command line: the contract's commands (`makeCli`) with
 * their handlers, run over an argument list, ending in an exit code from
 * `EXIT`. The entry point reads the process and passes it in, so a test runs
 * the whole command line in process.
 *
 * - Help a person asks for goes to stdout; help and errors for a command
 *   line that is refused go to stderr, so stdout holds only a report.
 * - With `--output json`, a refused command line still writes its report,
 *   with the failure `BadFlag`.
 * - Logs go to stderr.
 */
import { ConfigProvider, Console, Data, Effect, Layer, Logger, Schema } from "effect"
import { type CliError, CliOutput, Command, TerminalCapabilities } from "effect/cli"
import type { Registry } from "@runbooks/blocks-core/registry"
import type { FileSystem } from "@runbooks/core/services/FileSystem"
import { describeFailure } from "./cliFailure.ts"
import { type CliFailure, EXIT, makeCli, TestReport, ValidateReport } from "./contract.ts"
import { validate } from "./validate.ts"

export interface CliOptions {
  readonly registry: Registry
  /** This build's version: `--version`, and what a runbook's `runbooks:` requirement is checked against. */
  readonly appVersion: string
  /** Where relative paths resolve. */
  readonly cwd: string
  /** The process's environment. The `RUNBOOKS_` variables are read from it. */
  readonly env: Readonly<Record<string, string>>
}

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** The command ran, wrote its report, and the report says it failed. */
class CommandFailed extends Data.TaggedError("CommandFailed")<{}> {}

/** A command the contract has that this build does not do yet. */
class NotBuilt extends Data.TaggedError("NotBuilt")<{
  readonly command: string
  readonly lands: string
}> {}

const notBuilt = (command: string, lands: string) => () =>
  Effect.fail(new NotBuilt({ command, lands }))

const failUnless = (passed: boolean) => (passed ? Effect.void : Effect.fail(new CommandFailed()))

/** Help a person asked for on stdout, anything else the parser presents on stderr. */
const presenter: CliOutput.Presenter = {
  present: (event) =>
    Effect.gen(function* () {
      if (event._tag === "Version" || (event._tag === "Help" && event.reason === "Requested"))
        return yield* CliOutput.defaultPresenter.present(event)
      const { canColor } = yield* TerminalCapabilities.TerminalCapabilities
      const formatter = CliOutput.defaultFormatter({ colors: canColor })
      yield* Console.error(formatter.formatHelpDoc(event.helpDoc))
      if (event._tag === "InvalidInvocation")
        yield* Console.error(formatter.formatErrors(event.errors))
    }),
}

/**
 * The machine-format command a refused command line asked for, read from
 * the arguments as the contract's `--output` and `RUNBOOKS_OUTPUT` give it.
 * Undefined unless it names `test` or `validate` and asks for `json`.
 */
function jsonCommand(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): "test" | "validate" | undefined {
  const command = argv.find((arg) => !arg.startsWith("-"))
  if (command !== "test" && command !== "validate") return undefined
  let output = env.RUNBOOKS_OUTPUT
  argv.forEach((arg, i) => {
    if (arg === "--output") output = argv[i + 1]
    else if (arg.startsWith("--output=")) output = arg.slice("--output=".length)
  })
  return output === "json" ? command : undefined
}

function badFlag(errors: ReadonlyArray<CliError.CliError>): CliFailure {
  const first = errors[0]
  const flag =
    first === undefined
      ? ""
      : "option" in first
        ? `--${first.option}`
        : "argument" in first
          ? `<${first.argument}>`
          : ""
  return { _tag: "BadFlag", flag, message: first?.message ?? "The command line was refused." }
}

const refusedReport = (command: "test" | "validate", failure: CliFailure): unknown =>
  command === "validate"
    ? Schema.encodeSync(ValidateReport)({ version: 1, outcome: "invalid", runbooks: [], failure })
    : Schema.encodeSync(TestReport)({
        version: 1,
        outcome: "failed",
        runbooks: [],
        summary: { runbooks: 0, passed: 0, failed: 0, skipped: 0, warnings: 0 },
        failure,
      })

/** Runs `runbooks <argv>`, writes what it reports, and gives the exit code. */
export const runCli = (
  argv: ReadonlyArray<string>,
  options: CliOptions,
): Effect.Effect<ExitCode, never, Command.Environment | FileSystem> => {
  const cli = makeCli<CommandFailed | NotBuilt, FileSystem>({
    open: notBuilt("open", "phase 3, with the app frame"),
    mcp: notBuilt("mcp", "phase 3, with the MCP tools"),
    test: notBuilt("test", "work product 2.10"),
    validate: (args) => Effect.flatMap(validate(args, options), failUnless),
  })
  return Command.runWith(cli, { version: options.appVersion })(argv).pipe(
    Effect.as<ExitCode>(EXIT.success),
    Effect.catchTags({
      CommandFailed: () => Effect.succeed(EXIT.failure),
      NotBuilt: ({ command, lands }) =>
        Console.error(`runbooks ${command} is not built yet: it lands with ${lands}.`).pipe(
          Effect.as(EXIT.failure),
        ),
      // The parser has presented the help and the errors. A refused command
      // line that asked for json still gets its report.
      ShowHelp: ({ errors }) =>
        Effect.gen(function* () {
          const command = jsonCommand(argv, options.env)
          if (command !== undefined && errors.length > 0) {
            const failure = badFlag(errors)
            yield* Console.error(describeFailure(failure))
            yield* Console.log(JSON.stringify(refusedReport(command, failure), null, 2))
          }
          return EXIT.failure
        }),
    }),
    Effect.catch((error) => Console.error(error.message).pipe(Effect.as(EXIT.failure))),
    Effect.provide(
      Layer.mergeAll(
        CliOutput.layerPresenter(presenter),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.env)),
        Logger.layer([Logger.withConsoleError(Logger.formatSimple)]),
      ),
    ),
  )
}
