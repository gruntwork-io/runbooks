/**
 * The settings file on disk: `settings.json` in the app's data folder,
 * which the entry point passes in. `settings.imported` beside it, an empty
 * file, marks that today's settings were imported.
 *
 * `replace` and `keepAside` each write a temporary file beside their
 * target and rename it into place, so a reader finds the old file or the
 * new one. Each write's temporary file has a name of its own, and goes if
 * the write fails. Every file is created readable and writable by its owner
 * only, and a missing data folder is created for its owner only.
 */
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Layer, Option } from "effect"
import { FileReadError, FileWriteError } from "@runbooks/core/errors"
import type { FileHead } from "@runbooks/core/services/FileSystem"
import { MAX_SETTINGS_BYTES, SettingsFile } from "@runbooks/core/services/SettingsFile"

const OWNER_ONLY_FILE = 0o600
const OWNER_ONLY_FOLDER = 0o700

const codeIs = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

const isMissing = (error: unknown): boolean => codeIs(error, "ENOENT")

/** At most `MAX_SETTINGS_BYTES` of a regular file, or none if there is no file. It fails rather than wait on a named pipe. */
async function readHead(file: string): Promise<Option.Option<FileHead>> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (isMissing(error)) return Option.none()
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${file} is not a regular file.`)
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return Option.some({
      text: buffer.subarray(0, Math.min(length, MAX_SETTINGS_BYTES)).toString("utf8"),
      truncated: length > MAX_SETTINGS_BYTES,
    })
  } finally {
    await handle.close()
  }
}

/**
 * Puts a new owner-only file at `target` in one step: `fill` writes the
 * temporary file it is renamed from. The temporary file's name is this
 * write's own, so a second writer at the same moment, such as a second
 * Runbooks, never opens or removes it; the last rename wins, whole.
 */
async function replaceWith(target: string, fill: (temporary: string) => Promise<void>) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: OWNER_ONLY_FOLDER })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fill(temporary)
    await fs.rename(temporary, target)
  } catch (error) {
    // The write's own error is the one to give, not one removing its file.
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** The settings file in `dataFolder`. */
export const nodeSettingsFile = (dataFolder: string): Layer.Layer<SettingsFile> => {
  const file = path.join(dataFolder, "settings.json")
  const aside = path.join(dataFolder, "settings.unreadable.json")
  const importedMark = path.join(dataFolder, "settings.imported")
  return Layer.succeed(
    SettingsFile,
    SettingsFile.of({
      path: file,
      read: Effect.tryPromise({
        try: () => readHead(file),
        catch: (cause) => new FileReadError({ path: file, cause }),
      }),
      replace: (text) =>
        Effect.tryPromise({
          try: () =>
            replaceWith(file, async (temporary) => {
              // `wx` creates it, so the mode is the one given here, and never follows a link.
              const handle = await fs.open(temporary, "wx", OWNER_ONLY_FILE)
              try {
                await handle.writeFile(text, "utf8")
                await handle.sync()
              } finally {
                await handle.close()
              }
            }),
          catch: (cause) => new FileWriteError({ path: file, cause }),
        }),
      keepAside: Effect.tryPromise({
        try: async () => {
          await replaceWith(aside, async (temporary) => {
            await fs.copyFile(file, temporary, constants.COPYFILE_EXCL)
            await fs.chmod(temporary, OWNER_ONLY_FILE)
          })
          return aside
        },
        catch: (cause) => new FileWriteError({ path: aside, cause }),
      }),
      imported: Effect.tryPromise({
        try: () =>
          fs.lstat(importedMark).then(
            () => true,
            (error: unknown) => {
              if (isMissing(error)) return false
              throw error
            },
          ),
        catch: (cause) => new FileReadError({ path: importedMark, cause }),
      }),
      markImported: Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dataFolder, { recursive: true, mode: OWNER_ONLY_FOLDER })
          try {
            await (await fs.open(importedMark, "wx", OWNER_ONLY_FILE)).close()
          } catch (error) {
            if (!codeIs(error, "EEXIST")) throw error
          }
        },
        catch: (cause) => new FileWriteError({ path: importedMark, cause }),
      }),
    }),
  )
}
