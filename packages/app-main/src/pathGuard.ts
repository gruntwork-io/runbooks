/**
 * The path guard for the files main serves the window from a folder: the
 * renderer's build (pageScheme.ts) and a runbook's assets.
 *
 * A URL's path names a file under the folder that is its root. The path is
 * percent-decoded before the check, so the path checked is the path served,
 * and containment is checked once every symbolic link is followed, so
 * neither `..`, an encoded separator nor a link planted in the folder
 * reaches a file outside it.
 */
import path from "node:path"
import { Effect, Option } from "effect"
import { FileSystem } from "@runbooks/core/services/FileSystem"

/**
 * The regular file under `root` that `url`'s path names, or undefined when
 * the path is not valid percent-encoding, leads outside `root`, or names
 * no regular file there.
 */
export const servedFile = (
  url: URL,
  root: string,
): Effect.Effect<string | undefined, never, FileSystem> =>
  Effect.gen(function* () {
    let relative: string
    try {
      relative = decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
    const file = path.resolve(path.join(root, relative))
    const fs = yield* FileSystem
    if (!(yield* fs.isContainedInReal(file, root))) return undefined
    const stat = yield* Effect.option(fs.stat(file))
    return Option.isSome(stat) && stat.value.isFile ? file : undefined
  })
