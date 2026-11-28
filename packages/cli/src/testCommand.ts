/**
 * `runbooks test`: each runbook's `runbook_test.yml`, run by the engine in
 * process (`testRun.ts`), and one report in the format asked for.
 *
 * Every runbook and every test file is loaded before anything runs, so a
 * test file that does not decode stops the command before any block runs.
 * Then the runbooks run, up to `--max-parallel` at once; a runbook whose
 * settings say `parallelizable: false` runs alone, after the others. The
 * report keeps the runbooks in path order, however they ran.
 *
 * Ctrl-C or SIGTERM (`stop`) cancels the running block of each runbook,
 * starts nothing more, and ends with the report so far, the failure
 * `Cancelled` and exit 1.
 */
import path from "node:path"
import {
  Clock,
  Console,
  Deferred,
  Effect,
  type Layer,
  Option,
  Random,
  Result,
  type Scope,
} from "effect"
import type { Registry, ServicesOf } from "@runbooks/blocks-core/registry"
import type { CredentialProviders } from "@runbooks/core/credential/provider"
import { loadRunbook } from "@runbooks/core/document/load"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { describeFailure } from "./cliFailure.ts"
import { shownPath } from "./configProblems.ts"
import type {
  CliFailure,
  RunbookTestReport,
  TestArgs,
  TestCaseReport,
  TestReport,
} from "./contract.ts"
import { findRunbooks } from "./runbookPaths.ts"
import { boundTestFile, isFuzzInput, readTestFile, targetsOf, type TestFile } from "./testFile.ts"
import { renderTestReport } from "./testReport.ts"
import { type Loaded, runTests } from "./testRun.ts"

const TEST_FILE = "runbook_test.yml"

interface TestOptions<R extends Registry> {
  readonly registry: R
  readonly appVersion: string
  /** Where relative paths resolve, and what printed paths are relative to. */
  readonly cwd: string
  /** The environment each test case's blocks start from. */
  readonly env: Readonly<Record<string, string>>
  /** Completes on the first Ctrl-C or SIGTERM. */
  readonly stop: Deferred.Deferred<void>
  /** What each test case's credential blocks sign in with. */
  readonly credentialProviders: Layer.Layer<CredentialProviders, never, FileSystem>
}

type Services<R extends Registry> = FileSystem | Exclude<ServicesOf<R>, Scope.Scope>

/** A runbook found, before its tests run. `document` is undefined when it does not open. */
interface Found extends Omit<Loaded, "document" | "testFile"> {
  readonly document: Loaded["document"] | undefined
  /** The test file, or why it could not be loaded: the runbook then fails one test, `config`. */
  readonly testFile: Result.Result<TestFile, string>
  readonly errors: RunbookTestReport["errors"]
  readonly warnings: RunbookTestReport["warnings"]
}

/** A runbook to test, and the test cases chosen from its test file: none when it could not be loaded. */
interface Chosen extends Found {
  readonly tests: TestFile["tests"]
}

const causeText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The runbooks the paths name that have a test file. A runbook named on its own without one is a warning. */
const runbooksWithTests = (paths: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const found = new Set<string>()
    for (const pattern of paths) {
      const files = yield* findRunbooks([pattern], cwd).pipe(
        Effect.catchIf(
          (failure) => failure._tag === "NoRunbooks",
          () => Effect.succeed([]),
        ),
      )
      for (const file of files) {
        if (found.has(file)) continue
        if (yield* fs.exists(path.join(path.dirname(file), TEST_FILE))) found.add(file)
        else if (!pattern.endsWith("/..."))
          yield* Console.error(
            `warning: ${shownPath(file, cwd)} has no ${TEST_FILE} next to it, so it was not tested.`,
          )
      }
    }
    if (found.size === 0)
      return yield* Effect.fail<CliFailure>({ _tag: "NoRunbooks", patterns: [...paths] })
    return [...found].sort()
  })

/** The runbook and its test file, decoded against the runbook's blocks. */
const load = <R extends Registry>(file: string, options: TestOptions<R>) =>
  Effect.gen(function* () {
    const parsed = yield* loadRunbook(file, options.registry, {
      appVersion: options.appVersion,
    }).pipe(
      Effect.catchTags({
        FileNotFoundError: () => Effect.fail<CliFailure>({ _tag: "PathNotFound", path: file }),
        FileReadError: ({ cause }) =>
          Effect.fail<CliFailure>({ _tag: "Unreadable", path: file, message: causeText(cause) }),
      }),
    )
    const testPath = path.join(path.dirname(file), TEST_FILE)
    // A runbook that does not open still has its test file read, unbound to
    // its blocks, so a broken test file is reported either way.
    const targets =
      parsed._tag === "Parsed" ? targetsOf(parsed.document, options.registry) : new Map()
    // A test file that can't be loaded fails its runbook's `config` test; the other runbooks still run.
    const testFile = yield* Effect.result(
      // Its message names the file as the report shows paths, with the line and column.
      readTestFile(
        testPath,
        parsed._tag === "Parsed" ? boundTestFile(targets) : undefined,
        shownPath(testPath, options.cwd),
      ).pipe(Effect.mapError(({ message }) => message)),
    )
    return {
      file,
      parsed,
      testFile,
      targets,
    }
  })

/** The one test of a runbook whose test file could not be loaded, as today's CLI names it. */
const badTestFile = (message: string): TestCaseReport => ({
  name: "config",
  outcome: "failed",
  durationMillis: 0,
  message,
  steps: [],
  assertions: [],
})

/** A test case of a runbook that does not open: failed, with nothing run. */
const notOpened = (name: string): TestCaseReport => ({
  name,
  outcome: "failed",
  durationMillis: 0,
  message: "The runbook does not open: see its errors.",
  steps: [],
  assertions: [],
})

/**
 * Runs `runbooks test` and writes its report: the data to stdout, or to
 * `--output-file`, and a failure's message to stderr. True when every test
 * passed and nothing failed.
 */
export const test = <R extends Registry>(
  args: TestArgs,
  options: TestOptions<R>,
): Effect.Effect<boolean, never, Services<R>> =>
  Effect.gen(function* () {
    const runbooks: RunbookTestReport[] = []
    let failure: CliFailure | undefined
    // Reported when a test case chosen draws from it, so its values can be drawn again.
    const fuzzSeed = Option.isSome(args.fuzzSeed)
      ? args.fuzzSeed.value
      : String(yield* Random.nextIntBetween(0, 2 ** 32 - 1))
    let fuzzed = false

    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        const files = yield* runbooksWithTests(args.paths, options.cwd)
        const all: Found[] = []
        for (const file of files) {
          const { parsed, testFile, targets } = yield* load(file, options)
          all.push({
            file,
            label: shownPath(file, options.cwd),
            document: parsed._tag === "Parsed" ? parsed.document : undefined,
            targets,
            testFile,
            errors: parsed._tag === "Invalid" ? parsed.errors : [],
            warnings: parsed._tag === "Parsed" ? parsed.document.warnings : parsed.warnings,
          })
        }
        return all
      }),
    )
    if (prepared._tag === "Failure") failure = prepared.failure
    else {
      const wanted = args.test._tag === "Some" ? args.test.value : undefined
      const chosen = prepared.success.flatMap((found): ReadonlyArray<Chosen> => {
        const { testFile } = found
        if (Result.isFailure(testFile)) return [{ ...found, testFile, tests: [] }]
        const tests = testFile.success.tests.filter(
          (t) => wanted === undefined || t.name === wanted,
        )
        return tests.length === 0 ? [] : [{ ...found, testFile, tests }]
      })
      if (wanted !== undefined && chosen.length === 0)
        failure = { _tag: "TestCaseNotFound", name: wanted, runbooks: prepared.success.length }
      else {
        fuzzed = chosen.some((found) =>
          found.tests.some((t) =>
            Object.values(t.inputs ?? {}).some((input) => isFuzzInput(input)),
          ),
        )
        const verbose = args.verbose
        const run = (found: (typeof chosen)[number]) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis
            const { document, testFile } = found
            const tests = Result.isFailure(testFile)
              ? [badTestFile(testFile.failure)]
              : document === undefined
                ? found.tests.map((t) => notOpened(t.name))
                : yield* runTests(
                    {
                      registry: options.registry,
                      appVersion: options.appVersion,
                      env: options.env,
                      verbose,
                      log: (line) => Console.error(line),
                      stop: options.stop,
                      fuzzSeed,
                      credentialProviders: options.credentialProviders,
                    },
                    { ...found, document, testFile: testFile.success },
                    found.tests,
                  )
            const ended = yield* Clock.currentTimeMillis
            return {
              path: found.file,
              durationMillis: ended - started,
              errors: found.errors,
              warnings: found.warnings,
              tests,
            } satisfies RunbookTestReport
          })
        const alone = (found: (typeof chosen)[number]) =>
          Result.isSuccess(found.testFile) &&
          found.testFile.success.settings?.parallelizable === false
        const together = chosen.filter((found) => !alone(found))
        const reports = new Map<string, RunbookTestReport>()
        yield* Effect.forEach(
          together,
          (found) => Effect.map(run(found), (report) => reports.set(found.file, report)),
          { concurrency: args.maxParallel, discard: true },
        )
        for (const found of chosen.filter(alone)) reports.set(found.file, yield* run(found))
        for (const found of chosen) runbooks.push(reports.get(found.file)!)
        if (yield* Deferred.isDone(options.stop)) failure = { _tag: "Cancelled" }
      }
    }

    const count = (outcome: "passed" | "failed" | "skipped") =>
      runbooks.reduce((n, r) => n + r.tests.filter((t) => t.outcome === outcome).length, 0)
    const failed = count("failed")
    const report: TestReport = {
      version: 1,
      outcome: failure === undefined && failed === 0 ? "passed" : "failed",
      runbooks,
      summary: {
        runbooks: runbooks.length,
        passed: count("passed"),
        failed,
        skipped: count("skipped"),
        warnings: runbooks.reduce((n, r) => n + r.warnings.length, 0),
      },
      ...(fuzzed ? { fuzzSeed } : {}),
      ...(failure === undefined ? {} : { failure }),
    }
    if (failure !== undefined) yield* Console.error(describeFailure(failure))
    const rendered = renderTestReport(report, args.output, {
      cwd: options.cwd,
      verbose: args.verbose,
    })
    if (args.outputFile._tag === "Some") {
      const fs = yield* FileSystem
      const target = path.resolve(options.cwd, args.outputFile.value)
      const written = yield* Effect.result(fs.writeFile(target, rendered))
      if (written._tag === "Failure") {
        yield* Console.error(
          `${args.outputFile.value} could not be written (${causeText(written.failure.cause)}), so the report follows here.`,
        )
        yield* Console.log(rendered.trimEnd())
      }
    } else yield* Console.log(rendered.trimEnd())
    return report.outcome === "passed"
  })
