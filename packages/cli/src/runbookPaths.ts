/**
 * The runbooks a command line names. A path is a runbook file, a folder that
 * holds `runbook.mdx`, or a folder ending in `/...`, which names every
 * `runbook.mdx` under it. A relative path resolves against the working
 * directory the entry point passes in.
 */
import path from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import type { CliFailure } from "./contract.ts"

export const RUNBOOK_FILE = "runbook.mdx"

/** How many files and folders one `/...` looks through before it fails with `TooManyFiles`. */
export const MAX_WALKED_ENTRIES = 20_000

const RECURSIVE = "/..."

/** A folder a `/...` walk does not enter: installed dependencies, and hidden folders such as `.git`. */
const isSkipped = (name: string): boolean => name === "node_modules" || name.startsWith(".")

const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** Every `runbook.mdx` under `folder`, sorted by path. */
const walk = (
  pattern: string,
  folder: string,
): Effect.Effect<ReadonlyArray<string>, CliFailure, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const found: string[] = []
    const pending = [folder]
    let walked = 0
    while (pending.length > 0) {
      const dir = pending.pop()!
      const entries = yield* fs.readdirWithTypes(dir).pipe(
        Effect.mapError(({ cause }): CliFailure => ({
          _tag: "Unreadable",
          path: dir,
          message: causeText(cause),
        })),
      )
      walked += entries.length
      if (walked > MAX_WALKED_ENTRIES)
        return yield* Effect.fail<CliFailure>({
          _tag: "TooManyFiles",
          path: pattern,
          limit: MAX_WALKED_ENTRIES,
        })
      for (const entry of entries) {
        const child = path.join(dir, entry.name)
        if (entry.isFile && entry.name === RUNBOOK_FILE) found.push(child)
        else if (entry.isDirectory && !isSkipped(entry.name)) pending.push(child)
      }
    }
    return found.sort()
  })

/** The runbooks one path names. */
const runbooksOf = (
  pattern: string,
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, CliFailure, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const recursive = pattern.endsWith(RECURSIVE)
    const written = recursive ? pattern.slice(0, -RECURSIVE.length) || "." : pattern
    const target = path.resolve(cwd, written)
    const notFound: CliFailure = { _tag: "PathNotFound", path: pattern }
    const stat = yield* fs.stat(target).pipe(Effect.mapError(() => notFound))
    if (recursive)
      return stat.isDirectory ? yield* walk(pattern, target) : yield* Effect.fail(notFound)
    if (!stat.isDirectory) return [target]
    const runbook = path.join(target, RUNBOOK_FILE)
    if (!(yield* fs.exists(runbook)))
      return yield* Effect.fail<CliFailure>({ _tag: "PathNotFound", path: runbook })
    return [runbook]
  })

/**
 * The absolute path of each runbook `patterns` names, in the order given,
 * each once. Fails with the first path that names nothing, and with
 * `NoRunbooks` when no path names a runbook.
 */
export const findRunbooks = (
  patterns: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, CliFailure, FileSystem> =>
  Effect.gen(function* () {
    const found = new Set<string>()
    for (const pattern of patterns)
      for (const runbook of yield* runbooksOf(pattern, cwd)) found.add(runbook)
    if (found.size === 0)
      return yield* Effect.fail<CliFailure>({ _tag: "NoRunbooks", patterns: [...patterns] })
    return [...found]
  })
