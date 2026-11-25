/**
 * The settings file: the only file the settings store reads and writes
 * (`../engine/settings.ts`). platform-node's `NodeSettingsFile` keeps it
 * under the app's data folder; tests use `../test-utils/TestSettingsFile.ts`.
 */
import { Context, type Effect, type Option } from "effect"
import type { FileReadError, FileWriteError } from "../errors/index.ts"
import type { FileHead } from "./FileSystem.ts"

/** The most of the settings file that is read. Settings take about a kilobyte, so a file this size is not settings. */
export const MAX_SETTINGS_BYTES = 64 * 1024

export interface SettingsFileShape {
  /** Where the file is, to show the person. */
  readonly path: string
  /** At most `MAX_SETTINGS_BYTES` of the file, and whether it held more. None when there is no file. */
  readonly read: Effect.Effect<Option.Option<FileHead>, FileReadError>
  /**
   * Replaces the file in one step, so a reader finds the old file or the
   * new one, never part of either. The new file is readable and writable by
   * its owner only.
   */
  readonly replace: (text: string) => Effect.Effect<void, FileWriteError>
  /**
   * Copies the file as it is, every byte, to a file beside it that only its
   * owner can read, and returns that file's path. The file itself is left
   * alone. A copy kept before is replaced.
   */
  readonly keepAside: Effect.Effect<string, FileReadError | FileWriteError>
}

export class SettingsFile extends Context.Service<SettingsFile, SettingsFileShape>()(
  "@runbooks/core/services/SettingsFile",
) {}
