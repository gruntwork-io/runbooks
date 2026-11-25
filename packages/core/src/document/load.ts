/**
 * `loadRunbook`: reads a runbook and each file its blocks name, and parses
 * it. Clients load runbooks through it, so a document's hash covers every
 * script and template a block uses, and a missing one fails at load.
 */
import path from "node:path"
import { Effect } from "effect"
import type { RunbookPath } from "@runbooks/blocks-core/contract"
import type { Registry } from "@runbooks/blocks-core/registry"
import type { FileNotFoundError, FileReadError } from "../errors/index.ts"
import { FileSystem } from "../services/FileSystem.ts"
import type { ParseResult } from "./document.ts"
import { type FileFact, readRunbookFile } from "./files.ts"
import { startParse } from "./parse.ts"

/**
 * The runbook at `file`, parsed, with the files its blocks name read from
 * its folder. Fails only when the runbook itself can't be read; every
 * problem in it is a configuration error in the result.
 */
export const loadRunbook = (
  file: string,
  registry: Registry,
  options: { readonly appVersion: string },
): Effect.Effect<ParseResult, FileNotFoundError | FileReadError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const source = yield* fs.readFile(file)
    const parse = startParse(source, registry, { file, appVersion: options.appVersion })
    const folder = path.dirname(file)
    const facts = new Map<RunbookPath, FileFact>()
    for (const named of parse.files) facts.set(named, yield* readRunbookFile(folder, named))
    return parse.finish(facts)
  })
