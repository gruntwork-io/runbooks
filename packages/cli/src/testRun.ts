/**
 * One runbook's tests, run by the engine through the in-process client, as
 * the app runs them. Each test case gets an engine of its own over a
 * temporary folder, which holds the session's working folder and its
 * credential state and is removed when the test case ends, however it ends.
 *
 * A test case draws its fuzz inputs (`fuzz.ts`), opens the runbook, trusts
 * it, enters its inputs, then runs each step in order: a task or form
 * through `RunBlock`, a credential by waiting for its state, a display
 * block by its configuration. The first step that does not end as it
 * expects ends the test case, as today.
 *
 * The caller is a person (`Origin` "person"): the person running
 * `runbooks test` chose these runbooks on the command line, which is how the
 * CLI trusts a runbook, and only a person may trust one.
 */
import path from "node:path"
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import type { FieldValue } from "@runbooks/blocks-core/form"
import { type Registry, resolveTag, type ServicesOf } from "@runbooks/blocks-core/registry"
import type { BlockNode, RunbookDocument } from "@runbooks/core/document/document"
import { serveEngine } from "@runbooks/core/handlers"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import { type BlockView, type EngineClient, LIMITS, type SessionId } from "@runbooks/core/protocol"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { NoSavedSessions } from "@runbooks/core/sessionStore"
import type { AssertionReport, ExpectedStatus, StepReport, TestCaseReport } from "./contract.ts"

type AssertionResult = typeof AssertionReport.Type
import { fuzzValue } from "./fuzz.ts"
import { DefaultSettings, NoCredentialProviders } from "./testIsolation.ts"
import {
  type Assertion,
  DEFAULT_EXPECT,
  FuzzInput,
  type Step,
  type Target,
  type TestCase,
  type TestFile,
} from "./testFile.ts"

interface RunOptions<R extends Registry> {
  readonly registry: R
  readonly appVersion: string
  /** The environment `runbooks test` was started with. Each test case's `env` goes on top. */
  readonly env: Readonly<Record<string, string>>
  /** Stream every log line as it arrives, through `log`. */
  readonly verbose: boolean
  /** Where streamed log lines go: stderr. */
  readonly log: (line: string) => Effect.Effect<void>
  /** Completes on the first Ctrl-C or SIGTERM. */
  readonly stop: Deferred.Deferred<void>
}

/** A runbook ready to test: its document, and its blocks as the test file binds them. */
export interface Loaded {
  readonly file: string
  /** How log lines name the runbook when several run at once. */
  readonly label: string
  readonly document: RunbookDocument
  readonly targets: ReadonlyMap<string, Target>
  readonly testFile: TestFile
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A step's time limit when `settings.timeout` sets none: today's. */
const DEFAULT_TIMEOUT_MILLIS = 5 * 60 * 1000
/** How long a cancelled run has to end before the step reports it still running. */
const CANCEL_WAIT_MILLIS = 10_000
/** How long a credential block has to settle after the session is trusted. */
const CREDENTIAL_WAIT_MILLIS = 30_000
/** The log lines a step's report keeps: its last. */
const REPORTED_LOG_LINES = 200
/** The largest file a file assertion reads. */
const MAX_ASSERTED_FILE_BYTES = 1024 * 1024

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const

/** `settings.timeout` in milliseconds. The schema has checked its form. */
function timeoutMillis(timeout: string | undefined): number {
  const match = timeout === undefined ? null : /^(\d+)(ms|s|m|h)$/u.exec(timeout)
  if (match === null) return DEFAULT_TIMEOUT_MILLIS
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
}

// ---------------------------------------------------------------------------
// What this build does not run yet
// ---------------------------------------------------------------------------

/**
 * Why `runbooks test` cannot run the runbook's tests as the file asks, or
 * undefined. Each is a key the format has and the engine does not do yet;
 * a test that uses one fails, never passes without it.
 */
function notBuiltForFile(file: TestFile): string | undefined {
  const settings = file.settings ?? undefined
  if (settings?.use_temp_working_dir === false || settings?.working_dir !== undefined)
    return "settings.working_dir and use_temp_working_dir: false are not built yet: each test case runs in a temporary working folder of its own."
  if (settings?.output_path !== undefined && settings.output_path !== "generated")
    return "settings.output_path is not built yet: generated files go to generated/ in the working folder."
  return undefined
}

function notBuiltForCase(test: TestCase): string | undefined {
  const asserts = [
    ...(test.assertions ?? []),
    ...(test.steps ?? []).flatMap((s) => s.assertions ?? []),
  ]
  if (asserts.some((a) => a.type === "script"))
    return "script assertions are not built yet: runbooks test runs no command of its own."
  if ((test.cleanup ?? []).length > 0)
    return "cleanup is not built yet: runbooks test runs no command of its own."
  return undefined
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

const toBlockId = Schema.decodeSync(BlockId)
const isBlockId = Schema.is(Schema.NonEmptyString)
/** A decoded input is a fuzz configuration exactly when it has the `fuzz` key, which no value has. */
const isFuzzInput = Schema.is(FuzzInput)

/**
 * The values the test's inputs give each block, by its id, a fuzz input
 * drawn: or the first input whose fuzz settings draw nothing, and why. An
 * input left empty gives none.
 */
const answersOf = (test: TestCase) =>
  Effect.gen(function* () {
    const answers = new Map<string, Record<string, FieldValue>>()
    for (const [key, input] of Object.entries(test.inputs ?? {})) {
      if (input === null) continue
      const value = isFuzzInput(input)
        ? yield* fuzzValue(input.fuzz).pipe(
            Effect.mapError(({ message }) => `inputs ${key}: ${message}`),
          )
        : input
      const dot = key.indexOf(".")
      const values = answers.get(key.slice(0, dot)) ?? {}
      values[key.slice(dot + 1)] = value
      answers.set(key.slice(0, dot), values)
    }
    return answers
  })

interface Ended {
  readonly actual: string
  readonly message?: string | undefined
  readonly exitCode?: number
  readonly view?: BlockView
}

type Blocker = Extract<NonNullable<BlockView["status"]>, { readonly _tag: "Blocked" }>["by"][number]

/** What a blocked block waits for, after "Waiting for". */
function waitingFor(blocker: Blocker): string {
  switch (blocker._tag) {
    case "Untrusted":
      return "trust"
    case "WaitingFor":
      return blocker.block
    case "EmptyInput":
      return `a value for ${blocker.input} in ${blocker.block}`
    case "Exclusive":
      return `${blocker.block} to finish`
    default: {
      const unhandled: never = blocker
      throw new Error(`runbooks test has no words for the blocker ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** What a block's status says it did, as a step's `actual`. */
function endedAs(view: BlockView, node: BlockNode | undefined): Ended {
  const { status } = view
  if (status === undefined)
    return (node?.errors.length ?? 0) > 0
      ? { actual: "config_error", message: node!.errors[0]!.message, view }
      : { actual: "success", view }
  switch (status._tag) {
    case "Done":
      return { actual: status.outcome === "warning" ? "warn" : "success", view }
    case "Misconfigured":
      return { actual: "config_error", message: node?.errors[0]?.message, view }
    case "Blocked":
      return {
        actual: "blocked",
        message: `Waiting for ${status.by.map(waitingFor).join(", ")}`,
        view,
      }
    case "NeedsInput":
      return { actual: "fail", message: `Needs input: ${status.fields.join(", ")}`, view }
    case "Idle":
      return { actual: "idle", message: "The block did not run.", view }
    case "Running":
      return { actual: "running", message: "The block is still running.", view }
    case "Failed": {
      const { error } = status
      switch (error._tag) {
        case "TaskCancelled":
          return { actual: "cancelled", message: "The run was cancelled.", view }
        case "TaskTimedOut":
          return { actual: "timeout", message: "The run timed out.", view }
        case "TaskFailed":
          return {
            actual: "fail",
            message: error.message,
            ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
            view,
          }
        case "CredentialError":
          return { actual: "fail", message: `${error.kind}: ${error.message}`, view }
        case "TaskBlocked":
          return { actual: "blocked", message: `Waiting for ${error.by.join(", ")}`, view }
        case "PropError":
        case "PathOutsideRoot":
          return { actual: "fail", message: error.message, view }
      }
    }
  }
}

interface Session {
  readonly client: EngineClient
  readonly session: SessionId
  readonly registry: Registry
  readonly document: RunbookDocument
  readonly generated: string
  readonly timeout: number
  readonly stop: Deferred.Deferred<void>
}

/** Waits for the block to stop running, up to `millis`; then, or on Ctrl-C or SIGTERM, cancels it. */
const settle = (s: Session, block: BlockId, millis: number) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + millis
    const waited = Effect.gen(function* () {
      for (;;) {
        const left = deadline - (yield* Clock.currentTimeMillis)
        if (left <= 0) return undefined
        const { block: view, timedOut } = yield* s.client.WaitForBlock({
          session: s.session,
          block,
          timeoutMillis: Math.max(1, Math.min(left, LIMITS.maxWaitMillis)),
        })
        if (!timedOut) return view
      }
    })
    const outcome = yield* Effect.raceFirst(
      waited.pipe(Effect.map((view) => (view === undefined ? "timedOut" : view))),
      Deferred.await(s.stop).pipe(Effect.as("stopped" as const)),
    )
    if (typeof outcome !== "string") return { view: outcome, why: undefined }
    yield* s.client.CancelBlock({ session: s.session, block })
    const { block: view } = yield* s.client.WaitForBlock({
      session: s.session,
      block,
      timeoutMillis: CANCEL_WAIT_MILLIS,
    })
    return { view, why: outcome }
  })

/**
 * For a form step's `set_outputs`: the field each output carries, as the
 * block declares it. A name it does not declare stays as written, so
 * SetValues refuses it.
 */
function fieldOfOutput(
  registry: Registry,
  node: BlockNode | undefined,
): (output: string) => string {
  const block = node === undefined ? undefined : resolveTag(registry, node.tag)?.block
  const declared =
    block?.class === "form" && node?.props !== undefined ? block.outputs(node.props) : {}
  const fields = new Map(Object.entries(declared).map(([output, { field }]) => [output, field]))
  return (output) => fields.get(output) ?? output
}

/** Runs the step's block, or skips it, and says how it ended. */
const runBlock = (
  s: Session,
  step: Step,
  target: Target | undefined,
  node: BlockNode | undefined,
) =>
  Effect.gen(function* () {
    const expect = step.expect ?? DEFAULT_EXPECT
    if (expect === "skip") return { actual: "skip" } satisfies Ended
    const block = toBlockId(step.block)
    if (target?.kind === "display" || node?.class === "display")
      return endedAs(yield* s.client.GetBlock({ session: s.session, block }), node)
    if (node?.class === "credential") {
      const { view } = yield* settle(s, block, CREDENTIAL_WAIT_MILLIS)
      return endedAs(view, node)
    }
    if (step.set_outputs !== undefined) {
      const fieldOf = fieldOfOutput(s.registry, node)
      const given = Object.entries(step.set_outputs)
      const { rejected } = yield* s.client.SetValues({
        session: s.session,
        block,
        values: Object.fromEntries(given.map(([output, value]) => [fieldOf(output), value])),
      })
      // Each refusal under the output the test file names, not the field it carries.
      const refused = given.flatMap(([output]) => {
        const field = fieldOf(output)
        return Object.hasOwn(rejected, field) ? [[output, rejected[field]] as const] : []
      })
      if (refused.length > 0)
        return {
          actual: "fail",
          message: refused.map(([name, why]) => `set_outputs.${name}: ${why}`).join("; "),
        } satisfies Ended
    }
    const result = yield* s.client.RunBlock({ session: s.session, block })
    switch (result._tag) {
      case "Submitted":
        return endedAs(yield* s.client.GetBlock({ session: s.session, block }), node)
      case "AwaitingApproval":
        return { actual: "fail", message: "The run waits for an approval no one can give." }
      case "Refused": {
        const view = yield* s.client.GetBlock({ session: s.session, block })
        const { reason } = result
        switch (reason._tag) {
          case "Misconfigured":
            return { actual: "config_error", message: node?.errors[0]?.message, view }
          case "Blocked":
            return endedAs({ ...view, status: { _tag: "Blocked", by: reason.by } }, node)
          case "NeedsInput":
            return { actual: "fail", message: `Needs input: ${reason.fields.join(", ")}`, view }
          case "NeedsReview":
            return {
              actual: "fail",
              message: `Needs review: ${reason.unreviewed.join(", ")}`,
              view,
            }
          case "AlreadyRunning":
            return { actual: "fail", message: "The block is already running.", view }
        }
      }
      case "Started": {
        const { view, why } = yield* settle(s, block, s.timeout)
        const ended = endedAs(view, node)
        if (why === "timedOut")
          return {
            ...ended,
            actual: "timeout",
            message: `The run took longer than ${s.timeout} ms.`,
          }
        return ended
      }
    }
  })

/** The last lines of the block's latest run's log, as text. */
const logOf = (s: Session, block: BlockId) =>
  Effect.gen(function* () {
    const { log } = yield* s.client.GetBlock({ session: s.session, block, logLimit: 0 })
    const total = log?.total ?? 0
    if (total === 0) return undefined
    const page = yield* s.client.GetBlock({
      session: s.session,
      block,
      logOffset: Math.max(0, total - REPORTED_LOG_LINES),
      logLimit: REPORTED_LOG_LINES,
    })
    return (page.log?.lines ?? []).map((line) => line.text).join("\n")
  })

/** Whether `ended` is what the step expects, and why not. */
function verdict(step: Step, expect: ExpectedStatus, ended: Ended, node: BlockNode | undefined) {
  if (expect === "hidden")
    return { passed: false, message: "No block is hidden: this version has no showWhenBlock." }
  if (ended.actual !== expect)
    return {
      passed: false,
      message: `Expected ${expect}, got ${ended.actual}${ended.message === undefined ? "" : `: ${ended.message}`}`,
    }
  if (expect === "config_error" && step.error_contains !== undefined) {
    const wanted = step.error_contains.toLowerCase()
    const errors = node?.errors.map((e) => e.message) ?? []
    if (!errors.some((message) => message.toLowerCase().includes(wanted)))
      return {
        passed: false,
        message: `No configuration error contains "${step.error_contains}": ${errors.join("; ") || "none"}`,
      }
  }
  return { passed: true, message: ended.message }
}

/** `outputs.<block>.<key>`, as `missing_outputs` writes one. */
const OUTPUT_REFERENCE = /^outputs\.([^.]+)\.(.+)$/u

const runStep = (s: Session, step: Step, target: Target | undefined, verbose: boolean) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const expect = step.expect ?? DEFAULT_EXPECT
    const node = s.document.blocks.find(
      (b) => b.id !== undefined && (b.id === step.block || b.idAsWritten === step.block),
    )
    const report = (ended: Ended, passed: boolean, message: string | undefined, log?: string) =>
      Effect.map(Clock.currentTimeMillis, (now): StepReport => ({
        block: step.block,
        expected: expect,
        actual: ended.actual,
        passed,
        ...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }),
        durationMillis: now - started,
        ...(message === undefined ? {} : { message }),
        outputs: ended.view?.outputs ?? {},
        ...(log === undefined ? {} : { log }),
        assertions: [],
      }))
    if (node === undefined || !isBlockId(step.block))
      return yield* report(
        { actual: "missing" },
        false,
        `The runbook has no block with the id "${step.block}".`,
      )
    const ended = yield* runBlock(s, step, target, node)
    let { passed, message } = verdict(step, expect, ended, node)
    if (passed && expect === "blocked" && step.missing_outputs !== undefined) {
      const outputs = yield* s.client.GetOutputs({ session: s.session })
      const present = step.missing_outputs.filter((reference) => {
        const [, block, key] = OUTPUT_REFERENCE.exec(reference) ?? []
        return block !== undefined && key !== undefined && outputs[block]?.[key] !== undefined
      })
      if (present.length > 0) {
        passed = false
        message = `Expected these outputs to be missing, but they are set: ${present.join(", ")}`
      }
    }
    const ran = ended.actual !== "skip" && ended.actual !== "missing"
    const log = ran && (verbose || !passed) ? yield* logOf(s, toBlockId(step.block)) : undefined
    return yield* report(ended, passed, message, log)
  })

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const assertion = (type: string, failure: string | undefined): AssertionResult =>
  failure === undefined ? { type, passed: true } : { type, passed: false, message: failure }

const check = (s: Session, a: Assertion) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const at = (p: string) => (path.isAbsolute(p) ? p : path.resolve(s.generated, p))
    const statOf = (p: string) => Effect.option(fs.stat(at(p)))
    const readText = (p: string) =>
      fs.readFileUpTo(at(p), MAX_ASSERTED_FILE_BYTES).pipe(
        Effect.map(({ text, truncated }) =>
          truncated ? { error: `${p} is larger than ${MAX_ASSERTED_FILE_BYTES} bytes.` } : { text },
        ),
        Effect.catch(() => Effect.succeed({ error: `${p} does not exist or cannot be read.` })),
      )
    const output = (block: string, key: string) =>
      Effect.map(s.client.GetOutputs({ session: s.session }), (all) => all[toBlockId(block)]?.[key])
    switch (a.type) {
      case "file_exists": {
        const stat = yield* statOf(a.path)
        return assertion(
          a.type,
          Option.isSome(stat) && stat.value.isFile ? undefined : `${a.path} is not a file.`,
        )
      }
      case "dir_exists": {
        const stat = yield* statOf(a.path)
        return assertion(
          a.type,
          Option.isSome(stat) && stat.value.isDirectory ? undefined : `${a.path} is not a folder.`,
        )
      }
      case "file_not_exists":
      case "dir_not_exists": {
        const stat = yield* statOf(a.path)
        return assertion(a.type, Option.isNone(stat) ? undefined : `${a.path} exists.`)
      }
      case "file_contains":
      case "file_not_contains": {
        const read = yield* readText(a.path)
        if ("error" in read) return assertion(a.type, read.error)
        const has = read.text.includes(a.contains)
        return assertion(
          a.type,
          has === (a.type === "file_contains")
            ? undefined
            : `${a.path} ${has ? "contains" : "does not contain"} "${a.contains}".`,
        )
      }
      case "file_matches": {
        const read = yield* readText(a.path)
        if ("error" in read) return assertion(a.type, read.error)
        const pattern = Effect.try(() => new RegExp(a.pattern))
        const regex = yield* Effect.option(pattern)
        if (Option.isNone(regex))
          return assertion(a.type, `${a.pattern} is not a regular expression.`)
        return assertion(
          a.type,
          regex.value.test(read.text) ? undefined : `${a.path} does not match ${a.pattern}.`,
        )
      }
      case "file_equals": {
        const read = yield* readText(a.path)
        if ("error" in read) return assertion(a.type, read.error)
        return assertion(
          a.type,
          read.text === a.value ? undefined : `${a.path} is not "${a.value}".`,
        )
      }
      case "output_exists": {
        const value = yield* output(a.block, a.output)
        return assertion(
          a.type,
          value === undefined ? `${a.block} has no output ${a.output}.` : undefined,
        )
      }
      case "output_equals":
      case "output_matches": {
        const value = yield* output(a.block, a.output)
        if (value === undefined) return assertion(a.type, `${a.block} has no output ${a.output}.`)
        if (value._tag === "Hidden")
          return assertion(
            a.type,
            `${a.block}'s output ${a.output} is sensitive, so a test cannot read it.`,
          )
        if (a.type === "output_equals")
          return assertion(
            a.type,
            value.value === a.value
              ? undefined
              : `${a.block}.${a.output} is "${value.value}", not "${a.value}".`,
          )
        const regex = yield* Effect.option(Effect.try(() => new RegExp(a.pattern)))
        if (Option.isNone(regex))
          return assertion(a.type, `${a.pattern} is not a regular expression.`)
        return assertion(
          a.type,
          regex.value.test(value.value)
            ? undefined
            : `${a.block}.${a.output} is "${value.value}", which does not match ${a.pattern}.`,
        )
      }
      case "files_generated": {
        const files = yield* s.client
          .GetBlock({ session: s.session, block: toBlockId(a.block), logLimit: 0 })
          .pipe(
            Effect.map((view) => Option.some(view.files ?? [])),
            Effect.catchTag("UnknownBlock", () => Effect.succeedNone),
          )
        if (Option.isNone(files))
          return assertion(a.type, `The runbook has no block with the id "${a.block}".`)
        const count = files.value.filter(({ change }) => change !== "deleted").length
        const wanted = a.min_count ?? 1
        return assertion(
          a.type,
          count >= wanted
            ? undefined
            : `${a.block} generated ${count} ${count === 1 ? "file" : "files"}, fewer than ${wanted}.`,
        )
      }
      case "script":
        return assertion(a.type, "script assertions are not built yet.")
    }
  })

/** Checks each assertion in order, up to the first that fails. */
const checkAll = (s: Session, assertions: ReadonlyArray<Assertion>) =>
  Effect.gen(function* () {
    const reports: AssertionResult[] = []
    for (const a of assertions) {
      const report = yield* check(s, a)
      reports.push(report)
      if (!report.passed) break
    }
    return reports
  })

// ---------------------------------------------------------------------------
// One test case
// ---------------------------------------------------------------------------

/** Each block once, in document order: an external one skipped, the rest expected to succeed. */
function everyBlock(loaded: Loaded): ReadonlyArray<Step> {
  return loaded.document.blocks.flatMap((node) => {
    if (node.idAsWritten === undefined) return []
    const target = loaded.targets.get(node.idAsWritten)
    return [
      { block: node.idAsWritten, expect: target?.kind === "external" ? "skip" : DEFAULT_EXPECT },
    ]
  })
}

/** The engine one test case runs on: its own, over `folder`, with nothing of the person's. */
const engineFor = <R extends Registry>(
  options: RunOptions<R>,
  folder: string,
  env: Readonly<Record<string, string>>,
) =>
  serveEngine({
    registry: options.registry,
    appVersion: options.appVersion,
    workingFolders: path.join(folder, "working"),
    stateFolders: path.join(folder, "state"),
    processEnvironment: { ...options.env, ...env },
    // As today's runner: the test file's `timeout` setting, which `settle` keeps, limits every step.
    blockTimeLimits: "ignore",
    // As today's runner: a test's inputs reach each block that reads them, with no Submit.
    formValues: "live",
  }).pipe(
    Layer.provideMerge(DefaultSettings),
    Layer.provide(NoCredentialProviders),
    Layer.provide(NoSavedSessions),
  )

/**
 * Streams each log line of the session to `options.log` while the test case
 * runs. The stream ends when the session closes.
 */
const streamLogs = <R extends Registry>(
  options: RunOptions<R>,
  loaded: Loaded,
  client: EngineClient,
  session: SessionId,
) =>
  client.Events({ session }).pipe(
    Stream.runForEach((envelope) => {
      const { event } = envelope
      if (event._tag !== "LogLines") return Effect.void
      return Effect.forEach(event.lines, (line) =>
        options.log(`${loaded.label} ${event.block} | ${line.text}`),
      )
    }),
    Effect.ignore,
    Effect.forkScoped,
  )

/** How long the log stream has to print the last lines once the session closes. */
const LOG_DRAIN_MILLIS = 5_000

const failedCase = (name: string, started: number, message: string) =>
  Effect.map(Clock.currentTimeMillis, (now): TestCaseReport => ({
    name,
    outcome: "failed",
    durationMillis: now - started,
    message,
    steps: [],
    assertions: [],
  }))

const runCase = <R extends Registry>(options: RunOptions<R>, loaded: Loaded, test: TestCase) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const notBuilt = notBuiltForFile(loaded.testFile) ?? notBuiltForCase(test)
    if (notBuilt !== undefined) return yield* failedCase(test.name, started, notBuilt)
    // As today's runner: every input is drawn before anything runs.
    const answers = yield* Effect.result(answersOf(test))
    if (Result.isFailure(answers)) return yield* failedCase(test.name, started, answers.failure)

    const fs = yield* FileSystem
    const folder = yield* Effect.acquireRelease(fs.mkdtemp("runbooks-test-"), (dir) =>
      Effect.ignore(fs.rm(dir, { recursive: true, force: true })),
    )
    const body = Effect.gen(function* () {
      const client = yield* makeInProcessClient("person")
      const opened = yield* client.OpenSession({ path: loaded.file })
      if (opened._tag === "Invalid")
        return yield* failedCase(test.name, started, opened.errors.map((e) => e.message).join("\n"))
      const { session, trust } = opened.session
      // Closing the session cancels what still runs, and ends the log stream
      // once its last lines are printed.
      const logs = options.verbose ? yield* streamLogs(options, loaded, client, session) : undefined
      yield* Effect.addFinalizer(() =>
        client
          .CloseSession({ session })
          .pipe(
            Effect.andThen(
              logs === undefined
                ? Effect.void
                : Fiber.join(logs).pipe(Effect.timeout(LOG_DRAIN_MILLIS)),
            ),
            Effect.ignore,
          ),
      )
      const trusted = yield* client.TrustSession({ session, hash: trust.hash })
      if (trusted._tag !== "Trusted")
        return yield* failedCase(test.name, started, "The runbook changed while it was opened.")

      const s: Session = {
        client,
        session,
        registry: options.registry,
        document: loaded.document,
        generated: path.join(folder, "working", session, "generated"),
        timeout: timeoutMillis(loaded.testFile.settings?.timeout),
        stop: options.stop,
      }

      for (const [id, values] of answers.success) {
        const { rejected } = yield* client.SetValues({ session, block: toBlockId(id), values })
        const refused = Object.entries(rejected)
        if (refused.length > 0)
          return yield* failedCase(
            test.name,
            started,
            refused.map(([field, why]) => `inputs ${id}.${field}: ${why}`).join("\n"),
          )
      }

      const steps =
        test.steps === undefined || test.steps === null || test.steps.length === 0
          ? everyBlock(loaded)
          : test.steps
      const reports: StepReport[] = []
      let failure: string | undefined
      for (const step of steps) {
        if (yield* Deferred.isDone(options.stop)) {
          failure = "Stopped by Ctrl-C or SIGTERM."
          break
        }
        const report = yield* runStep(s, step, loaded.targets.get(step.block), options.verbose)
        const assertions =
          report.passed && step.assertions ? yield* checkAll(s, step.assertions) : []
        reports.push({ ...report, assertions })
        if (!report.passed) {
          failure = `${step.block}: ${report.message ?? `expected ${report.expected}, got ${report.actual}`}`
          break
        }
        const failed = assertions.find((a) => !a.passed)
        if (failed !== undefined) {
          failure = `${step.block}: ${failed.type}: ${failed.message ?? "failed"}`
          break
        }
      }
      const assertions =
        failure === undefined && test.assertions ? yield* checkAll(s, test.assertions) : []
      const failedAssertion = assertions.find((a) => !a.passed)
      if (failure === undefined && failedAssertion !== undefined)
        failure = `${failedAssertion.type}: ${failedAssertion.message ?? "failed"}`
      const now = yield* Clock.currentTimeMillis
      return {
        name: test.name,
        outcome: failure === undefined ? "passed" : "failed",
        durationMillis: now - started,
        ...(failure === undefined ? {} : { message: failure }),
        steps: reports,
        assertions,
      } satisfies TestCaseReport
    })
    return yield* body.pipe(
      Effect.scoped,
      Effect.provide(engineFor(options, folder, test.env ?? {})),
    )
  }).pipe(
    Effect.scoped,
    // Anything the engine or the file system refuses fails this test case, not the run.
    Effect.catchCause((cause) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        failedCase(test.name, now, `runbooks test could not run it: ${Cause.pretty(cause)}`),
      ),
    ),
  )

/**
 * Runs the runbook's test cases, in order, each in a fresh engine. After
 * Ctrl-C or SIGTERM, the test cases not started are reported skipped.
 */
export const runTests = <R extends Registry>(
  options: RunOptions<R>,
  loaded: Loaded,
  tests: ReadonlyArray<TestCase>,
): Effect.Effect<
  ReadonlyArray<TestCaseReport>,
  never,
  FileSystem | Exclude<ServicesOf<R>, Scope.Scope>
> =>
  Effect.gen(function* () {
    const reports: TestCaseReport[] = []
    for (const test of tests) {
      if (yield* Deferred.isDone(options.stop)) {
        reports.push({
          name: test.name,
          outcome: "skipped",
          durationMillis: 0,
          message: "Not run: stopped by Ctrl-C or SIGTERM.",
          steps: [],
          assertions: [],
        })
        continue
      }
      reports.push(yield* runCase(options, loaded, test))
    }
    return reports
  })
