/**
 * The lookups and checks of an OpenTofu module, as its runbook_block.yml
 * declares them: loading and checking them for `runbooks-cli validate`, and
 * recording samples of their real answers into the module's simulation.yml
 * for `runbooks-cli lookups record`.
 */
import * as path from "node:path"
import { Effect } from "effect"
import YAML from "yaml"
import { FileSystem } from "../../services/FileSystem.ts"
import { loadDeclarations, type LoadedDeclarations } from "./load.ts"
import { parseInputLookups } from "./parse.ts"
import { sampleCheckResponse, sampleLookupResponse, type RecordOptions } from "./record.ts"
import { fieldsNoRowHas, isMissing, readPath, rowsOf } from "./response.ts"
import { firstResponse, type RunContext } from "./run.ts"
import type { Problem, Use } from "./types.ts"
import { checkDefinitions } from "./validate.ts"

export const METADATA_FILE = "runbook_block.yml"
export const SIMULATION_FILE = "simulation.yml"

/** The scenario `runbooks-cli lookups record` writes. */
export const RECORDED_SCENARIO = "recorded"

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Each variable's uses of lookups, by where they are, such as `variables.owners.lookup`. */
export function moduleLookupUses(
  doc: unknown,
  source: string,
): { uses: { where: string; use: Use }[]; problems: Problem[] } {
  const uses: { where: string; use: Use }[] = []
  const problems: Problem[] = []
  const variables = isObj(doc) ? doc.variables : undefined
  if (!isObj(variables)) return { uses, problems }
  for (const [name, raw] of Object.entries(variables)) {
    if (!isObj(raw)) continue
    const where = `variables.${name}`
    const parsed = parseInputLookups(raw, where, source)
    problems.push(...parsed.problems)
    for (const key of ["lookup", "prefill", "shortcut"] as const) {
      const use = parsed.lookups[key]
      if (use) uses.push({ where: `${where}.${key}`, use })
    }
  }
  return { uses, problems }
}

export interface ModuleDeclarations extends LoadedDeclarations {
  readonly file: string
  readonly uses: readonly { where: string; use: Use }[]
}

/** Read and check a module's declarations. A module with no runbook_block.yml has none. */
export const readModuleDeclarations = (moduleDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const file = path.join(moduleDir, METADATA_FILE)
    const empty: ModuleDeclarations = {
      file,
      definitions: { groups: {}, lookups: {}, checks: {} },
      preflight: [],
      uses: [],
      problems: [],
    }
    const text = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return empty
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      return {
        ...empty,
        problems: [{ source: file, message: `isn't valid YAML: ${(err as Error).message}` }],
      }
    }
    const loaded = yield* loadDeclarations(doc, file)
    const { uses, problems } = moduleLookupUses(doc, file)
    return {
      file,
      definitions: loaded.definitions,
      preflight: loaded.preflight,
      uses,
      problems: [
        ...loaded.problems,
        ...problems,
        ...checkDefinitions(loaded.definitions, {
          lookups: uses,
          preflight: loaded.preflight,
          source: file,
        }),
      ],
    } satisfies ModuleDeclarations
  })

/** One recorded answer: the use's params, and what the API sent. */
interface RecordedResponse {
  readonly with?: Readonly<Record<string, string>>
  readonly status: number
  readonly body: unknown
}

/**
 * Problems with the recorded answers in a module's simulation.yml: an answer
 * for a lookup or check the module doesn't define, or one its rows, fields or
 * expectation can't read, which means the declaration drifted from the API.
 */
export const checkSimulation = (moduleDir: string, declarations: ModuleDeclarations) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const file = path.join(moduleDir, SIMULATION_FILE)
    const text = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return []
    const problems: Problem[] = []
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      return [{ source: file, message: `isn't valid YAML: ${(err as Error).message}` }]
    }
    const scenarios = isObj(doc) && isObj(doc.scenarios) ? doc.scenarios : {}
    for (const [scenario, raw] of Object.entries(scenarios)) {
      const responses = isObj(raw) ? raw.responses : undefined
      if (responses === undefined) continue
      if (!isObj(responses)) {
        problems.push({
          source: file,
          message: `scenarios.${scenario}.responses must map lookups and checks to answers.`,
        })
        continue
      }
      for (const [id, answers] of Object.entries(responses)) {
        const where = `scenarios.${scenario}.responses.${id}`
        const lookup = declarations.definitions.lookups[id]
        const check = declarations.definitions.checks[id]
        if (!lookup && !check) {
          problems.push({
            source: file,
            message: `${where}: the module defines no lookup or check ${id}.`,
          })
          continue
        }
        if (!Array.isArray(answers)) {
          problems.push({ source: file, message: `${where} must be a list of answers.` })
          continue
        }
        for (const answer of answers as RecordedResponse[]) {
          if (!isObj(answer) || typeof answer.status !== "number") {
            problems.push({
              source: file,
              message: `${where}: each answer needs a status and a body.`,
            })
            continue
          }
          if (answer.status < 200 || answer.status >= 300) continue
          try {
            if (lookup) {
              const missing = fieldsNoRowHas(lookup, rowsOf(lookup, answer.body))
              if (missing.length > 0) {
                throw new Error(
                  `no row has ${missing.map((field) => `${lookup.fields[field]} (field ${field})`).join(", ")}. The path is wrong, or the API changed.`,
                )
              }
            } else if (
              check &&
              isMissing(readPath(answer.body, check.expect.path)) &&
              "equals" in check.expect
            ) {
              throw new Error(`the body has no ${check.expect.path}, which ${id} expects.`)
            }
          } catch (err) {
            problems.push({ source: file, message: `${where}: ${(err as Error).message}` })
          }
        }
      }
    }
    return problems
  })

/** A use, once: the same lookup with the same params is recorded once. */
const key = (use: Use) => `${use.from} ${JSON.stringify(use.with)}`

/**
 * Run each lookup and check the module uses once, through `context`, and
 * return the module's simulation.yml with their samples as the `recorded`
 * scenario. Other scenarios in the file are kept. Nothing is written.
 */
export const recordModule = (
  moduleDir: string,
  declarations: ModuleDeclarations,
  context: RunContext,
  options: RecordOptions,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const file = path.join(moduleDir, SIMULATION_FILE)
    const responses: Record<string, RecordedResponse[]> = {}
    const failures: string[] = []
    const seen = new Set<string>()
    const record = async (use: Use, kind: "lookup" | "check") => {
      if (seen.has(key(use))) return
      seen.add(key(use))
      try {
        const body = await firstResponse(context, use, kind)
        const sample =
          kind === "lookup"
            ? sampleLookupResponse(declarations.definitions.lookups[use.from]!, body, options)
            : sampleCheckResponse(declarations.definitions.checks[use.from]!, body, options)
        const answer = {
          ...(Object.keys(use.with).length > 0 ? { with: use.with } : {}),
          status: 200,
          body: sample,
        }
        ;(responses[use.from] ??= []).push(answer)
      } catch (err) {
        failures.push(`${use.from}: ${(err as Error).message}`)
      }
    }
    yield* Effect.promise(async () => {
      for (const { use } of declarations.uses) await record(use, "lookup")
      for (const use of declarations.preflight) await record(use, "check")
    })

    const existing = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => ""))
    const doc = YAML.parseDocument(existing || "scenarios: {}\n")
    doc.setIn(["scenarios", RECORDED_SCENARIO], {
      label: "Recorded",
      description: options.keepValues
        ? "Answers recorded from the real APIs, with their real values."
        : "Answers recorded from the real APIs, with placeholder values.",
      responses,
    })
    return { file, text: doc.toString(), failures }
  })
