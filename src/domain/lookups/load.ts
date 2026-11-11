/**
 * Loads the lookups and checks a module's runbook_block.yml or a form's
 * boilerplate.yml declares, with the shared definitions it includes.
 *
 * An include is a path relative to the file, and it must stay inside the same
 * repository, so a module is reproducible at its pinned ref: its shared
 * definitions come from the same commit as the module.
 */
import * as path from "node:path"
import { Effect } from "effect"
import YAML from "yaml"
import { isContainedInReal } from "../../path-validation.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { parseDeclarations, type FileDeclarations, type KeyPrefix } from "./parse.ts"
import type { Definitions, Problem, Use } from "./types.ts"
import { mergeDeclarations } from "./validate.ts"

export interface LoadedDeclarations {
  readonly definitions: Definitions
  readonly preflight: readonly Use[]
  readonly problems: readonly Problem[]
}

/**
 * The declarations in `doc`, parsed from the file at `file`, merged with the
 * files it includes. Problems are returned, never thrown, so a caller can show
 * them all at once.
 */
export const loadDeclarations = (doc: unknown, file: string, prefix: KeyPrefix = "") =>
  Effect.gen(function* () {
    const own = parseDeclarations(doc, file, prefix)
    const problems: Problem[] = []
    const includes: FileDeclarations[] = []
    if (own.include.length > 0) {
      const root = yield* repositoryRoot(path.dirname(file))
      for (const relative of own.include) {
        const included = yield* readInclude(file, relative, root)
        if ("problem" in included) problems.push({ source: file, message: included.problem })
        else includes.push(included.declarations)
      }
    }
    const merged = mergeDeclarations(own, includes)
    return {
      definitions: merged.definitions,
      preflight: merged.preflight,
      problems: [...problems, ...merged.problems],
    } satisfies LoadedDeclarations
  })

/** The nearest folder at or above `dir` that holds a .git, or `dir` when none does. */
const repositoryRoot = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    for (let current = path.resolve(dir); ; current = path.dirname(current)) {
      if (yield* fs.exists(path.join(current, ".git"))) return current
      if (path.dirname(current) === current) return path.resolve(dir)
    }
  })

const readInclude = (file: string, relative: string, root: string) =>
  Effect.gen(function* () {
    if (path.isAbsolute(relative) || /^[a-z][a-z0-9+.-]*:/i.test(relative)) {
      return {
        problem: `include ${relative} must be a path relative to this file, in the same repository.`,
      }
    }
    const resolved = path.resolve(path.dirname(file), relative)
    const inside = yield* Effect.promise(() => isContainedInReal(resolved, root))
    if (!inside) {
      return {
        problem: `include ${relative} is outside the repository, so it wouldn't come from the module's ref.`,
      }
    }
    const fs = yield* FileSystem
    const text = yield* fs.readFile(resolved).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return { problem: `include ${relative} doesn't exist.` }
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      return { problem: `include ${relative} isn't valid YAML: ${(err as Error).message}` }
    }
    const declarations = parseDeclarations(doc, resolved)
    if (declarations.include.length > 0) {
      return {
        problem: `include ${relative} includes other files. Shared definitions are one level deep.`,
      }
    }
    return { declarations }
  })
