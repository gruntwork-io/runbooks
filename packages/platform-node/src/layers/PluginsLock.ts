/**
 * `resources/plugins.lock`: the plugins the app bundles, each with its
 * pinned version and one SHA-256 per platform its release builds. An entry
 * point reads it to build the transport owner's `PluginProcessConfig`, and
 * the packaged app ships it beside `bin`. `just bump-plugins` writes it.
 *
 * A platform an entry has no hash for has no binary: the owner answers
 * `notInstalled` there.
 */
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { Effect, Predicate, Schema } from "effect"
import { PluginEntry } from "@runbooks/core/plugin/transport"

/** The lock is a few KiB. A larger file is refused. */
export const MAX_LOCK_BYTES = 64 * 1024

/** The lock file's content. A plugin is pinned once per kind. */
export const PluginsLock = Schema.Struct({ plugins: Schema.Array(PluginEntry) }).check(
  Schema.makeFilter((lock: { readonly plugins: ReadonlyArray<PluginEntry> }) =>
    lock.plugins.flatMap((entry, at) =>
      lock.plugins.findIndex((other) => other.kind === entry.kind && other.name === entry.name) < at
        ? [
            {
              path: ["plugins", at],
              issue: `The ${entry.kind} plugin ${entry.name} is pinned twice.`,
            },
          ]
        : [],
    ),
  ),
)
export type PluginsLock = typeof PluginsLock.Type

/** The lock could not be read, or is not a lock. `problem` says which, and where in the file. */
export class PluginsLockInvalid extends Schema.TaggedError<PluginsLockInvalid>()(
  "PluginsLockInvalid",
  { file: Schema.String, problem: Schema.String },
) {
  override get message(): string {
    return `${this.file}: ${this.problem}`
  }
}

const decode = Schema.decodeUnknownEffect(PluginsLock, { errors: "all" })

/** The pinned plugins in the lock at `file`, a regular file of at most `MAX_LOCK_BYTES`. */
export const readPluginsLock = (
  file: string,
): Effect.Effect<ReadonlyArray<PluginEntry>, PluginsLockInvalid> =>
  Effect.gen(function* () {
    const invalid = (problem: string) => new PluginsLockInvalid({ file, problem })
    const text = yield* Effect.tryPromise({
      try: () => readBounded(file),
      catch: (error) =>
        invalid(
          Predicate.hasProperty(error, "code") && error.code === "ENOENT"
            ? "no such file"
            : messageOf(error),
        ),
    })
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) => invalid(`not JSON: ${messageOf(error)}`),
    })
    const lock = yield* decode(json).pipe(Effect.mapError((error) => invalid(error.message)))
    return lock.plugins
  })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The file's text. It fails rather than wait on a named pipe, and past `MAX_LOCK_BYTES`. */
async function readBounded(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file")
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_LOCK_BYTES) throw new Error(`larger than ${MAX_LOCK_BYTES} bytes`)
    return buffer.subarray(0, length).toString("utf8")
  } finally {
    await handle.close()
  }
}
