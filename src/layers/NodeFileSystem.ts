/**
 * Live implementation of the FileSystem service using Node.js fs/promises and chokidar.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { Effect, Layer, Stream } from "effect"
import { watch as chokidarWatch } from "chokidar"
import { FileSystem } from "../services/FileSystem.ts"
import type { FileSystemShape, WalkEntry, FileChangeEvent } from "../services/FileSystem.ts"
import {
  FileNotFoundError,
  FileReadError,
  FileWriteError,
  FileWatchError,
} from "../errors/index.ts"

function mapReadError(err: unknown, filePath: string): FileNotFoundError | FileReadError {
  if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return new FileNotFoundError({ path: filePath })
  }
  return new FileReadError({ path: filePath, cause: err })
}

const impl: FileSystemShape = {
  readFile: (filePath: string) =>
    Effect.tryPromise({
      try: () => fs.readFile(filePath, "utf-8"),
      catch: (err) => mapReadError(err, filePath),
    }),

  readFileBuffer: (filePath: string) =>
    Effect.tryPromise({
      try: () => fs.readFile(filePath),
      catch: (err) => mapReadError(err, filePath),
    }) as Effect.Effect<Buffer, FileNotFoundError | FileReadError>,

  readdir: (dirPath: string) =>
    Effect.tryPromise({
      try: () => fs.readdir(dirPath),
      catch: (err) => new FileReadError({ path: dirPath, cause: err }),
    }),

  readdirWithTypes: (dirPath: string) =>
    Effect.tryPromise({
      try: async () => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })
        return entries.map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
        }))
      },
      catch: (err) => new FileReadError({ path: dirPath, cause: err }),
    }),

  stat: (filePath: string) =>
    Effect.tryPromise({
      try: async () => {
        const s = await fs.stat(filePath)
        return {
          size: s.size,
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          mtime: s.mtime,
        }
      },
      catch: () => new FileNotFoundError({ path: filePath }),
    }),

  exists: (filePath: string) =>
    Effect.tryPromise({
      try: () =>
        fs.access(filePath).then(
          () => true,
          () => false,
        ),
      catch: () => false as never,
    }),

  writeFile: (filePath: string, content: string | Buffer) =>
    Effect.tryPromise({
      try: () => fs.writeFile(filePath, content),
      catch: (err) => new FileWriteError({ path: filePath, cause: err }),
    }),

  mkdir: (dirPath: string, options?: { recursive?: boolean }) =>
    Effect.tryPromise({
      try: () => fs.mkdir(dirPath, options).then(() => undefined),
      catch: (err) => new FileWriteError({ path: dirPath, cause: err }),
    }),

  rm: (filePath: string, options?: { recursive?: boolean; force?: boolean }) =>
    Effect.tryPromise({
      try: () => fs.rm(filePath, options),
      catch: (err) => new FileWriteError({ path: filePath, cause: err }),
    }),

  copyFile: (src: string, dest: string) =>
    Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(src, dest)
      },
      catch: (err) => new FileWriteError({ path: dest, cause: err }),
    }),

  mkdtemp: (prefix: string) =>
    Effect.tryPromise({
      try: () => fs.mkdtemp(path.join(os.tmpdir(), prefix)),
      catch: (err) => new FileWriteError({ path: prefix, cause: err }),
    }),

  realpath: (filePath: string) =>
    Effect.tryPromise({
      try: () => fs.realpath(filePath),
      catch: () => new FileNotFoundError({ path: filePath }),
    }),

  walk: (dir: string) =>
    // NOTE: This uses `Stream.async` (not `asyncScoped`) on purpose. In
    // `asyncScoped` the consumer only begins pulling after `register`
    // completes — so doing the full emit loop inside register deadlocks once
    // the internal queue fills (default bound: 16). `Stream.async` kicks off
    // register synchronously and emits/pulls run concurrently. We also pass
    // `"unbounded"` so `emit.single` never blocks on a slow consumer.
    Stream.async<WalkEntry, FileReadError>((emit) => {
      const walkDir = async (currentDir: string): Promise<void> => {
        const entries = await fs.readdir(currentDir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name)
          const relativePath = path.relative(dir, fullPath)
          const stat = await fs.stat(fullPath)
          await emit.single({
            path: fullPath,
            relativePath,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
            size: stat.size,
          })
          if (entry.isDirectory()) {
            await walkDir(fullPath)
          }
        }
      }
      walkDir(dir).then(
        () => emit.end(),
        (err) => emit.fail(new FileReadError({ path: dir, cause: err })),
      )
    }, "unbounded"),

  watch: (paths: string[]) =>
    Stream.async<FileChangeEvent, FileWatchError>((emit) => {
      let watcher: ReturnType<typeof chokidarWatch> | null = null
      try {
        watcher = chokidarWatch(paths, { ignoreInitial: true })

        const handler = (type: FileChangeEvent["type"]) => (filePath: string) => {
          emit.single({ type, path: filePath })
        }

        watcher.on("add", handler("add"))
        watcher.on("change", handler("change"))
        watcher.on("unlink", handler("unlink"))
        watcher.on("error", (err) => {
          emit.fail(new FileWatchError({ cause: err }))
        })
      } catch (err) {
        emit.fail(new FileWatchError({ cause: err }))
      }

      // Return cleanup effect to close the watcher when the stream terminates
      return Effect.promise(() => watcher?.close() ?? Promise.resolve())
    }),
}

export const NodeFileSystemLive = Layer.succeed(FileSystem, impl)
