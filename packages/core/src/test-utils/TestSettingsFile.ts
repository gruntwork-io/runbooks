/**
 * An in-memory `SettingsFile` for tests, and the settings store over one.
 * A test reads back what was written and kept aside, and can make any of
 * the file's calls fail as the disk would.
 */
import { Effect, Layer, Option } from "effect"
import type { SettingsChange } from "../engine/protocol.ts"
import { SETTINGS_VERSION, SettingsStore } from "../engine/settings.ts"
import { FileReadError, FileWriteError } from "../errors/index.ts"
import { MAX_SETTINGS_BYTES, SettingsFile } from "../services/SettingsFile.ts"

export const SETTINGS_PATH = "/data/settings.json"
const ASIDE_PATH = "/data/settings.unreadable.json"

export interface MemorySettingsFile {
  readonly layer: Layer.Layer<SettingsFile>
  /** The file's text now, or undefined when there is none. */
  readonly text: () => string | undefined
  /** The copy kept aside, if one was. */
  readonly aside: () => string | undefined
  /** Each text `replace` was given, in order, including one that failed. */
  readonly replaced: ReadonlyArray<string>
}

export interface Failures {
  readonly read?: boolean
  readonly replace?: boolean
  readonly keepAside?: boolean
}

/** A settings file holding `initial`, or none. Each call named in `fail` fails, as a disk error would. */
export function memorySettingsFile(initial?: string, fail: Failures = {}): MemorySettingsFile {
  let text = initial
  let aside: string | undefined
  const replaced: string[] = []
  const diskError = new Error("disk error")
  return {
    layer: Layer.succeed(
      SettingsFile,
      SettingsFile.of({
        path: SETTINGS_PATH,
        read: Effect.suspend(() => {
          if (fail.read === true)
            return Effect.fail(new FileReadError({ path: SETTINGS_PATH, cause: diskError }))
          if (text === undefined) return Effect.succeed(Option.none())
          const bytes = Buffer.from(text)
          return Effect.succeed(
            Option.some({
              text: bytes.subarray(0, MAX_SETTINGS_BYTES).toString("utf8"),
              truncated: bytes.length > MAX_SETTINGS_BYTES,
            }),
          )
        }),
        replace: (next) =>
          Effect.suspend(() => {
            replaced.push(next)
            if (fail.replace === true)
              return Effect.fail(new FileWriteError({ path: SETTINGS_PATH, cause: diskError }))
            text = next
            return Effect.void
          }),
        keepAside: Effect.suspend(() => {
          if (fail.keepAside === true)
            return Effect.fail(new FileWriteError({ path: ASIDE_PATH, cause: diskError }))
          aside = text
          return Effect.succeed(ASIDE_PATH)
        }),
      }),
    ),
    text: () => text,
    aside: () => aside,
    replaced,
  }
}

/** The settings store, its file holding `settings` as a person set them: none, by default. */
export const testSettingsStore = (settings: SettingsChange = {}): Layer.Layer<SettingsStore> =>
  SettingsStore.layer.pipe(
    Layer.provide(
      memorySettingsFile(JSON.stringify({ version: SETTINGS_VERSION, settings })).layer,
    ),
  )
