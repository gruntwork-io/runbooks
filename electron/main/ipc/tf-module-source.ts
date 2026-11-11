/**
 * Where a <TfModule> block's module is on this computer. A local `source` is
 * a folder in the session; a remote one, such as
 * `git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0`, is
 * cloned once per source while the app runs, with the credentials a remote
 * runbook's clone uses, so a private catalog opens after a GitHub sign-in.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Exit } from "effect"
import { runtime } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { describeCause, describeFailure } from "./ipc-error.ts"
import { cloneRemoteSource } from "../remote.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import { isContainedInReal } from "../../../src/path-validation.ts"
import { TfModuleError } from "../../../src/errors/index.ts"

/** Each remote source's module folder, or the clone in progress, by source. */
const clones = new Map<string, Promise<Exit.Exit<string, TfModuleError>>>()

/** Clones a remote source and finds the module's folder in the clone. */
const cloneModule = (source: string) =>
  Effect.gen(function* () {
    const cloned = yield* cloneRemoteSource(source).pipe(
      Effect.mapError((cause) => new TfModuleError({ message: describeFailure(cause), cause })),
    )
    const where = cloned.path ? `"${cloned.path}" in ${cloned.repoLabel}` : cloned.repoLabel
    const dir = cloned.path ? path.join(cloned.dest, cloned.path) : cloned.dest
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return yield* new TfModuleError({
        message: `There's no module folder at ${where}${cloned.at}.`,
      })
    }
    // The repository is untrusted: a symlink in it must not reach outside the clone.
    if (!(yield* Effect.promise(() => isContainedInReal(dir, cloned.dest)))) {
      return yield* new TfModuleError({ message: `${where} points outside the repository.` })
    }
    return dir
  })

/**
 * The module's folder. A failed clone isn't kept, so the block can read the
 * module again after a sign-in.
 */
export const moduleDir = (source: string) =>
  Effect.gen(function* () {
    if (!isRemoteSource(source)) return yield* validateSessionPath(source)
    let clone = clones.get(source)
    if (!clone) {
      clone = runtime.runPromiseExit(cloneModule(source)) as Promise<
        Exit.Exit<string, TfModuleError>
      >
      clones.set(source, clone)
    }
    const exit = yield* Effect.promise(() => clone)
    if (Exit.isFailure(exit)) {
      if (clones.get(source) === clone) clones.delete(source)
      return yield* new TfModuleError({ message: describeCause(exit.cause) })
    }
    return exit.value
  })
