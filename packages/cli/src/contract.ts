/**
 * The `runbooks` command line, as scripts and CI call it: its commands,
 * flags, environment variables, machine output and exit codes. The commands
 * are built here by `makeCli`; the CLI passes its handlers, so the parser,
 * `--help` and this contract cannot drift apart.
 *
 * - Data goes to stdout, everything else to stderr.
 * - `--output json` is the machine format. A failed command still writes its
 *   report, with the failure in it.
 * - A flag that configures behaviour has a `RUNBOOKS_` variable. A flag wins
 *   over its variable, which wins over the default.
 * - Nothing prompts.
 */
import type { Effect } from "effect"
import { Config, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ConfigError, ConfigWarning } from "@runbooks/core/document/configError"
import { OutputView } from "@runbooks/core/protocol"

/**
 * Open decision 13: the CLI is `runbooks`, and `runbooks-test`, the
 * compiled test runner's name today, stays as an alias. Under the
 * alternative this list is empty.
 */
export const CLI_NAME = "runbooks"
export const CLI_ALIASES = ["runbooks-test"] as const

/** Documented. A script may rely on them. */
export const EXIT = {
  /** Every test passed; every runbook is valid; the app opened. */
  success: 0,
  /**
   * A test failed or a runbook is invalid, a `runbook_test.yml` could not be
   * loaded, no runbook matched, `--test` named no test case, or a flag was
   * wrong. `--output json` says which, in `failure`.
   */
  failure: 1,
} as const

// ---------------------------------------------------------------------------
// Flags and arguments
// ---------------------------------------------------------------------------

const withEnv =
  <A>(config: Config.Config<A>) =>
  (flag: Flag.Flag<A>) =>
    flag.pipe(Flag.withFallbackConfig(config))

const paths = Argument.String("paths").pipe(
  Argument.withDescription(
    "Runbook files or folders. End a folder with /... to include every runbook under it.",
  ),
  Argument.atLeast(1),
)

const verbose = Flag.Boolean("verbose").pipe(
  Flag.withAlias("v"),
  Flag.withDescription("Print every step's log, not only a failed one's"),
  withEnv(Config.Boolean("RUNBOOKS_VERBOSE")),
  Flag.withDefault(false),
)

export const TestOutputFormat = Schema.Literals(["text", "junit", "json"])
export type TestOutputFormat = typeof TestOutputFormat.Type

const testOutput = Flag.Literals("output", TestOutputFormat.literals).pipe(
  Flag.withDescription("text for people, junit for CI test reports, json for scripts"),
  withEnv(Config.Literals(TestOutputFormat.literals, "RUNBOOKS_OUTPUT")),
  Flag.withDefault("text"),
)

export const ValidateOutputFormat = Schema.Literals(["text", "json"])
export type ValidateOutputFormat = typeof ValidateOutputFormat.Type

const validateOutput = Flag.Literals("output", ValidateOutputFormat.literals).pipe(
  Flag.withDescription("text for people, json for scripts"),
  withEnv(Config.Literals(ValidateOutputFormat.literals, "RUNBOOKS_OUTPUT")),
  Flag.withDefault("text"),
)

const outputFile = Flag.String("output-file").pipe(
  Flag.withDescription(
    "Write the report to this file instead of stdout. If it cannot be written, the report goes to stdout and the error to stderr.",
  ),
  Flag.optional,
)

const testCase = Flag.String("test").pipe(
  Flag.withDescription("Run only the test case with this name"),
  Flag.optional,
)

const maxParallel = Flag.Int("max-parallel").pipe(
  Flag.withDescription("Runbooks tested at once. Each runbook's tests still run in order."),
  Flag.filter(
    (n) => n >= 1,
    (n) => `--max-parallel must be at least 1, got ${n}`,
  ),
  withEnv(Config.Int("RUNBOOKS_MAX_PARALLEL")),
  Flag.withDefault(1),
)

const source = Argument.String("source").pipe(
  Argument.withDescription(
    "A runbook file or folder, or a git URL such as github.com/org/repo//path",
  ),
  Argument.optional,
)

/** What `open` and the bare `runbooks <source>` take. */
export const openConfig = {
  source,
  runbook: Flag.String("runbook").pipe(
    Flag.withDescription("The runbook to open, as a flag. Same as the positional source."),
    Flag.optional,
  ),
  watch: Flag.Boolean("watch").pipe(
    Flag.withDescription("Reload the runbook each time it is saved"),
    Flag.withDefault(false),
  ),
  disableLiveFileReload: Flag.Boolean("disable-live-file-reload").pipe(
    Flag.withDescription("With --watch, reload the runbook but not the scripts it names"),
    Flag.withDefault(false),
  ),
  /** Accepted so existing launch commands keep working. Runbooks sends no usage data. */
  noTelemetry: Flag.Boolean("no-telemetry").pipe(
    Flag.withDescription("No effect: Runbooks sends no usage data"),
    Flag.withDefault(false),
  ),
  /** The old Go CLI's flags. Accepted, warned about on stderr, ignored. */
  workingDir: Flag.String("working-dir").pipe(Flag.withHidden, Flag.optional),
  outputPath: Flag.String("output-path").pipe(Flag.withHidden, Flag.optional),
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const testConfig = {
  paths,
  verbose,
  test: testCase,
  output: testOutput,
  outputFile,
  maxParallel,
}

export const validateConfig = { paths, output: validateOutput }

export const mcpConfig = {
  app: Flag.Boolean("app").pipe(
    Flag.withDescription(
      "Attach to the running app's session instead of starting a headless one. The same tools either way.",
    ),
    Flag.withDefault(false),
  ),
}

type Args<C extends Command.Command.Config> = Command.Command.Config.Infer<C>
export type OpenArgs = Args<typeof openConfig>
export type TestArgs = Args<typeof testConfig>
export type ValidateArgs = Args<typeof validateConfig>
export type McpArgs = Args<typeof mcpConfig>

/** What the CLI does for each command. The contract fixes what each one is given. */
export interface Handlers<E, R> {
  readonly open: (args: OpenArgs) => Effect.Effect<void, E, R>
  readonly test: (args: TestArgs) => Effect.Effect<void, E, R>
  readonly validate: (args: ValidateArgs) => Effect.Effect<void, E, R>
  readonly mcp: (args: McpArgs) => Effect.Effect<void, E, R>
}

/** The `runbooks` command. A bare `runbooks <source>` opens it, as `runbooks open <source>` does. */
export const makeCli = <E, R>(handlers: Handlers<E, R>) =>
  Command.make(CLI_NAME, openConfig, handlers.open).pipe(
    Command.withDescription("Gruntwork Runbooks"),
    Command.withSubcommands([
      Command.make("open", openConfig, handlers.open).pipe(
        Command.withDescription("Open a runbook in the Runbooks app"),
      ),
      Command.make("test", testConfig, handlers.test).pipe(
        Command.withDescription("Run each runbook's runbook_test.yml"),
      ),
      Command.make("validate", validateConfig, handlers.validate).pipe(
        Command.withDescription(
          "Print a runbook's configuration errors with their lines. Runs nothing.",
        ),
      ),
      Command.make("mcp", mcpConfig, handlers.mcp).pipe(
        Command.withDescription("Serve Model Context Protocol tools over stdio"),
      ),
    ]),
  )

// ---------------------------------------------------------------------------
// Machine output: --output json
// ---------------------------------------------------------------------------

/** Why a command could not do what it was asked, beyond a test failing. A closed set. */
export const CliFailure = Schema.Union([
  Schema.TaggedStruct("NoRunbooks", { patterns: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("PathNotFound", { path: Schema.String }),
  /** A runbook that exists but could not be read. */
  Schema.TaggedStruct("Unreadable", { path: Schema.String, message: Schema.String }),
  /** A folder given with `/...` holds more files and folders than the CLI looks through. */
  Schema.TaggedStruct("TooManyFiles", { path: Schema.String, limit: Schema.Int }),
  Schema.TaggedStruct("TestCaseNotFound", { name: Schema.String, runbooks: Schema.Int }),
  Schema.TaggedStruct("BadTestFile", { path: Schema.String, message: Schema.String }),
  Schema.TaggedStruct("BadFlag", { flag: Schema.String, message: Schema.String }),
])
export type CliFailure = typeof CliFailure.Type

/** What a step expects of its block: `expect:` in `runbook_test.yml`. */
export const ExpectedStatus = Schema.Literals([
  "success",
  "fail",
  "warn",
  "blocked",
  "skip",
  "hidden",
  "config_error",
])
export type ExpectedStatus = typeof ExpectedStatus.Type

const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const AssertionReport = Schema.Struct({
  /** `file_exists`, `output_equals`, ... as written in `runbook_test.yml`. */
  type: Schema.String,
  passed: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
})

export const StepReport = Schema.Struct({
  block: Schema.String,
  expected: ExpectedStatus,
  /** What the block did: success, fail, warn, blocked, skip, hidden, config_error. */
  actual: Schema.String,
  passed: Schema.Boolean,
  exitCode: Schema.optionalKey(Schema.Int),
  durationMillis: Millis,
  message: Schema.optionalKey(Schema.String),
  /** Sensitive outputs are `Hidden`. */
  outputs: Schema.Record(Schema.String, OutputView),
  /** The step's log, when it failed or with --verbose. */
  log: Schema.optionalKey(Schema.String),
  assertions: Schema.Array(AssertionReport),
})
export type StepReport = typeof StepReport.Type

export const TestCaseReport = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(["passed", "failed", "skipped"]),
  durationMillis: Millis,
  message: Schema.optionalKey(Schema.String),
  steps: Schema.Array(StepReport),
  assertions: Schema.Array(AssertionReport),
})
export type TestCaseReport = typeof TestCaseReport.Type

export const RunbookTestReport = Schema.Struct({
  path: Schema.String,
  durationMillis: Millis,
  /** A runbook with configuration errors fails every test before any block runs. */
  errors: Schema.Array(ConfigError),
  warnings: Schema.Array(ConfigWarning),
  tests: Schema.Array(TestCaseReport),
})
export type RunbookTestReport = typeof RunbookTestReport.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** `runbooks test --output json`. */
export const TestReport = Schema.Struct({
  version: Schema.Literal(1),
  outcome: Schema.Literals(["passed", "failed"]),
  runbooks: Schema.Array(RunbookTestReport),
  summary: Schema.Struct({
    runbooks: Count,
    passed: Count,
    failed: Count,
    skipped: Count,
    warnings: Count,
  }),
  failure: Schema.optionalKey(CliFailure),
})
export type TestReport = typeof TestReport.Type

/** `runbooks validate --output json`. */
export const ValidateReport = Schema.Struct({
  version: Schema.Literal(1),
  outcome: Schema.Literals(["valid", "invalid"]),
  runbooks: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      errors: Schema.Array(ConfigError),
      warnings: Schema.Array(ConfigWarning),
    }),
  ),
  failure: Schema.optionalKey(CliFailure),
})
export type ValidateReport = typeof ValidateReport.Type
