import { Effect, Layer, Stream } from "effect"
import { FileSystem } from "../services/FileSystem.ts"
import type { WalkEntry } from "../services/FileSystem.ts"
import { FileNotFoundError, FileWriteError } from "../errors/index.ts"

export const makeTestFileSystem = (files: Record<string, string> = {}) => {
  const dirs = new Set<string>()

  return Layer.succeed(FileSystem, {
    readFile: (path) => {
      const content = files[path]
      return content !== undefined
        ? Effect.succeed(content)
        : Effect.fail(new FileNotFoundError({ path }))
    },

    readFileBuffer: (path) => {
      const content = files[path]
      return content !== undefined
        ? Effect.succeed(Buffer.from(content))
        : Effect.fail(new FileNotFoundError({ path }))
    },

    exists: (path) => Effect.succeed(path in files || dirs.has(path)),

    writeFile: (path, content) =>
      Effect.sync(() => {
        files[path] = String(content)
      }),

    appendFile: (path, content) =>
      Effect.sync(() => {
        files[path] = (files[path] ?? "") + content
      }),

    readdir: (path) => Effect.succeed(childNames(files, path)),

    readdirWithTypes: (path) =>
      Effect.succeed(
        childNames(files, path).map((name) => {
          const fullPath = path + "/" + name
          const isFile = fullPath in files
          return { name, isFile, isDirectory: !isFile }
        }),
      ),

    stat: (path) => {
      const content = files[path]
      return content !== undefined
        ? Effect.succeed({
            size: content.length,
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
          : Effect.fail(new FileNotFoundError({ path }))
    },

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

    copyFile: (src, dest) => {
      const content = files[src]
      return content !== undefined
        ? Effect.sync(() => {
            files[dest] = content
          })
        : Effect.fail(new FileWriteError({ path: dest, cause: `source ${src} not found` }))
    },

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
      const entries: WalkEntry[] = Object.entries(files)
        .filter(([f]) => f.startsWith(dir + "/") || f === dir)
        .map(([f, content]) => ({
          path: f,
          relativePath: f.startsWith(dir + "/") ? f.slice(dir.length + 1) : f,
          isFile: true,
          isDirectory: false,
          size: content.length,
        }))
      return Stream.fromIterable(entries)
    },

    watch: (_paths) => Stream.empty,
  })
}

/** The distinct first path segments under `path`, in insertion order. */
function childNames(files: Record<string, string>, path: string): string[] {
  const names = Object.keys(files)
    .filter((f) => f.startsWith(path + "/"))
    // split always yields at least one segment.
    .map((f) => f.slice(path.length + 1).split("/")[0]!)
  return [...new Set(names)]
}
