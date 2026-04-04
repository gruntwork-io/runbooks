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

export interface FileSystemShape {
  readonly readFile: (path: string) => Effect.Effect<string, FileNotFoundError | FileReadError>
  readonly readFileBuffer: (path: string) => Effect.Effect<Buffer, FileNotFoundError | FileReadError>
  readonly readdir: (path: string) => Effect.Effect<string[], FileReadError>
  readonly readdirWithTypes: (path: string) => Effect.Effect<Array<{ name: string; isFile: boolean; isDirectory: boolean }>, FileReadError>
  readonly stat: (path: string) => Effect.Effect<FileStat, FileNotFoundError>
  readonly exists: (path: string) => Effect.Effect<boolean>
  readonly writeFile: (path: string, content: string | Buffer) => Effect.Effect<void, FileWriteError>
  readonly mkdir: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, FileWriteError>
  readonly rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Effect.Effect<void, FileWriteError>
  readonly copyFile: (src: string, dest: string) => Effect.Effect<void, FileWriteError>
  readonly mkdtemp: (prefix: string) => Effect.Effect<string, FileWriteError>
  readonly realpath: (path: string) => Effect.Effect<string, FileNotFoundError>
  readonly walk: (dir: string) => Stream.Stream<WalkEntry, FileReadError>
  readonly watch: (paths: string[]) => Stream.Stream<FileChangeEvent, FileWatchError>
}

export class FileSystem extends Context.Tag("FileSystem")<FileSystem, FileSystemShape>() {}
