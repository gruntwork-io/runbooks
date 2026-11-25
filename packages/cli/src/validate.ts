/**
 * `runbooks validate`: each runbook parsed against the registry, and its
 * configuration errors and warnings printed with their lines. Nothing runs:
 * it reads each runbook and the files its blocks name, and nothing else.
 */
import { Console, Effect, Schema } from "effect"
import type { Registry } from "@runbooks/blocks-core/registry"
import { configErrors } from "@runbooks/core/document/document"
import { loadRunbook } from "@runbooks/core/document/load"
import type { FileSystem } from "@runbooks/core/services/FileSystem"
import { describeFailure } from "./cliFailure.ts"
import { problemLines, shownPath } from "./configProblems.ts"
import { type CliFailure, type ValidateArgs, ValidateReport } from "./contract.ts"
import { findRunbooks } from "./runbookPaths.ts"

export interface ValidateOptions {
  readonly registry: Registry
  /** Checked against each runbook's `runbooks:` requirement. */
  readonly appVersion: string
  /** Where relative paths resolve, and what printed paths are relative to. */
  readonly cwd: string
}

type Checked = ValidateReport["runbooks"][number]

const check = (
  file: string,
  { registry, appVersion }: ValidateOptions,
): Effect.Effect<Checked, CliFailure, FileSystem> =>
  loadRunbook(file, registry, { appVersion }).pipe(
    Effect.map((result) => ({
      path: file,
      errors: configErrors(result),
      warnings: result._tag === "Parsed" ? result.document.warnings : result.warnings,
    })),
    Effect.catchTags({
      FileNotFoundError: () => Effect.fail<CliFailure>({ _tag: "PathNotFound", path: file }),
      FileReadError: ({ cause }) =>
        Effect.fail<CliFailure>({
          _tag: "Unreadable",
          path: file,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
  )

/** The report as a person reads it. */
function text(report: ValidateReport, cwd: string): string {
  const lines: string[] = []
  for (const { path, errors, warnings } of report.runbooks) {
    if (errors.length === 0 && warnings.length === 0) lines.push(`${shownPath(path, cwd)}: valid`)
    for (const problem of [...errors, ...warnings]) lines.push(...problemLines(problem, cwd))
  }
  const invalid = report.runbooks.filter(({ errors }) => errors.length > 0).length
  const errors = report.runbooks.reduce((n, { errors: e }) => n + e.length, 0)
  const warnings = report.runbooks.reduce((n, { warnings: w }) => n + w.length, 0)
  lines.push(
    `${report.runbooks.length} checked: ${report.runbooks.length - invalid} valid, ${invalid} invalid. ${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`,
  )
  return lines.join("\n")
}

const encode = Schema.encodeSync(ValidateReport)

/**
 * Validates the runbooks `args` names and writes the report: the data to
 * stdout, a failure's message to stderr. True when every runbook is valid.
 * The first path that names nothing, or a runbook that cannot be read, stops
 * the command; the report holds the runbooks checked before it.
 */
export const validate = (
  args: ValidateArgs,
  options: ValidateOptions,
): Effect.Effect<boolean, never, FileSystem> =>
  Effect.gen(function* () {
    const checked: Checked[] = []
    let failure: CliFailure | undefined
    const files = yield* Effect.result(findRunbooks(args.paths, options.cwd))
    if (files._tag === "Failure") failure = files.failure
    else
      for (const file of files.success) {
        const result = yield* Effect.result(check(file, options))
        if (result._tag === "Failure") {
          failure = result.failure
          break
        }
        checked.push(result.success)
      }
    const valid = failure === undefined && checked.every(({ errors }) => errors.length === 0)
    const report: ValidateReport = {
      version: 1,
      outcome: valid ? "valid" : "invalid",
      runbooks: checked,
      ...(failure === undefined ? {} : { failure }),
    }
    if (failure !== undefined) yield* Console.error(describeFailure(failure))
    switch (args.output) {
      case "json":
        yield* Console.log(JSON.stringify(encode(report), null, 2))
        break
      case "text":
        if (checked.length > 0 || failure === undefined)
          yield* Console.log(text(report, options.cwd))
        break
      default: {
        const unhandled: never = args.output
        throw new Error(`Unhandled output format: ${String(unhandled)}`)
      }
    }
    return valid
  })
