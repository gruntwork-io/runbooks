import { Effect, Layer, Stream } from "effect"
import { FileSystem } from "../services/FileSystem.ts"
import type { WalkEntry } from "../services/FileSystem.ts"
import {
  FileNotFoundError,
  FileWriteError,
} from "../errors/index.ts"

export const makeTestFileSystem = (files: Record<string, string> = {}) => {
  const dirs = new Set<string>()

  return Layer.succeed(FileSystem, {
    readFile: (path) =>
      path in files
        ? Effect.succeed(files[path])
        : Effect.fail(new FileNotFoundError({ path })),

    readFileBuffer: (path) =>
      path in files
        ? Effect.succeed(Buffer.from(files[path]))
        : Effect.fail(new FileNotFoundError({ path })),

    exists: (path) => Effect.succeed(path in files || dirs.has(path)),

    writeFile: (path, content) =>
      Effect.sync(() => {
        files[path] = String(content)
      }),

    readdir: (path) =>
      Effect.succeed(
        Object.keys(files)
          .filter((f) => f.startsWith(path + "/"))
          .map((f) => f.slice(path.length + 1).split("/")[0])
          .filter((v, i, a) => a.indexOf(v) === i),
      ),

    readdirWithTypes: (path) =>
      Effect.succeed(
        Object.keys(files)
          .filter((f) => f.startsWith(path + "/"))
          .map((f) => f.slice(path.length + 1).split("/")[0])
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((name) => {
            const fullPath = path + "/" + name
            const isFile = fullPath in files
            return { name, isFile, isDirectory: !isFile }
          }),
      ),

    stat: (path) =>
      path in files
        ? Effect.succeed({
            size: files[path].length,
            isFile: true,
            isDirectory: false,
            mtime: new Date(),
          })
        : dirs.has(path)
          ? Effect.succeed({
              size: 0,
              isFile: false,
              isDirectory: true,
              mtime: new Date(),
            })
          : Effect.fail(new FileNotFoundError({ path })),

    mkdir: (path, _options?) =>
      Effect.sync(() => {
        dirs.add(path)
      }),

    rm: (path, _options?) =>
      Effect.sync(() => {
        delete files[path]
        dirs.delete(path)
        // Also remove any descendant paths.
        for (const key of Object.keys(files)) {
          if (key.startsWith(path + "/")) {
            delete files[key]
          }
        }
      }),

    copyFile: (src, dest) =>
      src in files
        ? Effect.sync(() => {
            files[dest] = files[src]
          })
        : Effect.fail(
            new FileWriteError({ path: dest, cause: `source ${src} not found` }),
          ),

    mkdtemp: (prefix) =>
      Effect.sync(() => {
        const tmpPath = `${prefix}${Math.random().toString(36).slice(2, 8)}`
        dirs.add(tmpPath)
        return tmpPath
      }),

    realpath: (path) =>
      path in files || dirs.has(path)
        ? Effect.succeed(path)
        : Effect.fail(new FileNotFoundError({ path })),

    walk: (dir) => {
      const entries: WalkEntry[] = Object.keys(files)
        .filter((f) => f.startsWith(dir + "/") || f === dir)
        .map((f) => ({
          path: f,
          relativePath: f.startsWith(dir + "/") ? f.slice(dir.length + 1) : f,
          isFile: true,
          isDirectory: false,
          size: files[f].length,
        }))
      return Stream.fromIterable(entries)
    },

    watch: (_paths) => Stream.empty,
  })
}
