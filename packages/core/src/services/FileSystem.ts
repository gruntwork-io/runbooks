import { Context, Effect, Stream } from "effect"
import type {
  FileNotFoundError,
  FileReadError,
  FileWriteError,
  FileWatchError,
} from "../errors/index.ts"

export interface FileStat {
  readonly size: number
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly mtime: Date
}

export interface WalkEntry {
  readonly path: string
  readonly relativePath: string
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly size: number
}

export interface FileChangeEvent {
  readonly type: "add" | "change" | "unlink"
  readonly path: string
}

export interface WatchOptions {
  /**
   * How many levels of subdirectories to watch below each watched directory.
   * 0 watches only the directory's own entries. Unset watches the whole tree.
   */
  readonly depth?: number
}

/** The start of a file, and whether it held more. */
export interface FileHead {
  readonly text: string
  /** The file held more than the bytes asked for; `text` is cut off. */
  readonly truncated: boolean
}

export interface FileSystemShape {
  readonly readFile: (path: string) => Effect.Effect<string, FileNotFoundError | FileReadError>
  /**
   * At most `maxBytes` of a regular file, for a file something other than
   * Runbooks wrote. It fails rather than wait on a named pipe, and reads
   * nothing from anything else that is not a regular file.
   */
  readonly readFileUpTo: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<FileHead, FileNotFoundError | FileReadError>
  readonly readFileBuffer: (
    path: string,
  ) => Effect.Effect<Buffer, FileNotFoundError | FileReadError>
  readonly readdir: (path: string) => Effect.Effect<string[], FileReadError>
  readonly readdirWithTypes: (
    path: string,
  ) => Effect.Effect<Array<{ name: string; isFile: boolean; isDirectory: boolean }>, FileReadError>
  readonly stat: (path: string) => Effect.Effect<FileStat, FileNotFoundError>
  readonly exists: (path: string) => Effect.Effect<boolean>
  readonly writeFile: (
    path: string,
    content: string | Buffer,
  ) => Effect.Effect<void, FileWriteError>
  /** Appends to the file, creating it if missing. */
  readonly appendFile: (path: string, content: string) => Effect.Effect<void, FileWriteError>
  readonly mkdir: (
    path: string,
    options?: { recursive?: boolean },
  ) => Effect.Effect<void, FileWriteError>
  readonly rm: (
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ) => Effect.Effect<void, FileWriteError>
  readonly copyFile: (src: string, dest: string) => Effect.Effect<void, FileWriteError>
  readonly mkdtemp: (prefix: string) => Effect.Effect<string, FileWriteError>
  readonly realpath: (path: string) => Effect.Effect<string, FileNotFoundError>
  /**
   * Whether `filePath` is inside `container` once every symbolic link in
   * either is followed, for a path that does not exist yet too. False when
   * either cannot be resolved.
   */
  readonly isContainedInReal: (filePath: string, container: string) => Effect.Effect<boolean>
  readonly walk: (dir: string) => Stream.Stream<WalkEntry, FileReadError>
  readonly watch: (
    paths: string[],
    options?: WatchOptions,
  ) => Stream.Stream<FileChangeEvent, FileWatchError>
}

export class FileSystem extends Context.Service<FileSystem, FileSystemShape>()("FileSystem") {}
