import { Effect, Layer, Option, Queue, Stream } from "effect"
import { FileSystem } from "../services/FileSystem.ts"
import type { FileChangeEvent, FileSystemShape, WalkEntry } from "../services/FileSystem.ts"
import {
  FileNotFoundError,
  FileReadError,
  FileWatchError,
  FileWriteError,
} from "../errors/index.ts"
import { isContainedIn } from "../path-validation.ts"

/** A file's content: text, or the bytes written. */
type Content = string | Uint8Array

export const makeTestFileSystem = (files: Record<string, string> = {}) =>
  Layer.succeed(FileSystem, testFileSystem(files))

/** The most links followed in a row, as the OS's own limit (40 on Linux). */
const MAX_LINKS_FOLLOWED = 40

/**
 * An in-memory filesystem holding `files`, `folders` as folders, and `links`,
 * each a symbolic link to the path it maps to. A link is followed only as the
 * last part of a path, not as a folder in one, and is neither a file nor a
 * folder in a listing. A file or folder created with a mode that lacks the
 * owner's read bit can't be read, as for any user but root.
 *
 * A watch reports each file written, appended to, copied to or removed
 * after it starts, as chokidar does with `ignoreInitial`: a watched file,
 * or a file in a watched folder no more than `depth` folders below it (0:
 * directly in it; unset: at any depth). Folders themselves are not
 * reported, as chokidar's `addDir` and `unlinkDir` are not.
 */
export const testFileSystem = (
  files: Record<string, Content> = {},
  folders: ReadonlyArray<string> = [],
  links: Readonly<Record<string, string>> = {},
): FileSystemShape => {
  const dirs = new Set<string>(folders)
  /** The mode each file or folder was created with, when it named one. */
  const modes = new Map<string, number>()
  const modeOf = (path: string, fallback: number) => Option.some(modes.get(path) ?? fallback)
  const unreadable = (path: string) => ((modes.get(path) ?? 0o400) & 0o400) === 0

  /** The path a link at `path` leads to, or `path`. */
  const target = (path: string): string => {
    let at = path
    for (let followed = 0; followed < MAX_LINKS_FOLLOWED; followed++) {
      const next = links[at]
      if (next === undefined) break
      at = next
    }
    return at
  }

  const read = (path: string): Effect.Effect<Content, FileNotFoundError | FileReadError> => {
    const at = target(path)
    const content = files[at]
    if (content === undefined) return Effect.fail(new FileNotFoundError({ path }))
    if (unreadable(at)) return Effect.fail(new FileReadError({ path, cause: "permission denied" }))
    return Effect.succeed(content)
  }

  /** Each watch running, with what it watches and how to tell it of a change. */
  const watches = new Set<{
    readonly paths: ReadonlyArray<string>
    readonly depth: number | undefined
    readonly report: (event: FileChangeEvent) => void
  }>()
  const report = (type: FileChangeEvent["type"], path: string) => {
    for (const watch of watches) {
      const seen = watch.paths.some((watched) => {
        if (path === watched) return true
        if (!path.startsWith(`${watched}/`)) return false
        const below = path.slice(watched.length + 1).split("/").length - 1
        return watch.depth === undefined || below <= watch.depth
      })
      if (seen) watch.report({ type, path })
    }
  }

  const listing = (path: string): Effect.Effect<string[], FileReadError> =>
    unreadable(path)
      ? Effect.fail(new FileReadError({ path, cause: "permission denied" }))
      : Effect.succeed(childNames([...Object.keys(files), ...Object.keys(links)], path))

  return {
    readFile: (path) => read(path).pipe(Effect.map(textOf)),

    readFileUpTo: (path, maxBytes) =>
      read(path).pipe(
        Effect.map((content) => {
          const bytes = bytesOf(content)
          return {
            text: bytes.subarray(0, maxBytes).toString("utf8"),
            truncated: bytes.length > maxBytes,
          }
        }),
      ),

    readFileBuffer: (path) => read(path).pipe(Effect.map(bytesOf)),

    readFileRange: (path, start, end) =>
      Stream.fromEffect(read(path)).pipe(
        Stream.map((content) => bytesOf(content).subarray(start, end + 1)),
      ),

    exists: (path) => Effect.succeed(target(path) in files || dirs.has(target(path))),

    writeFile: (path, content, options) =>
      Effect.sync(() => {
        const type = path in files ? "change" : "add"
        if (!(path in files) && options?.mode !== undefined) modes.set(path, options.mode)
        files[path] = typeof content === "string" ? content : Uint8Array.from(content)
        report(type, path)
      }),

    appendFile: (path, content) =>
      Effect.sync(() => {
        const type = path in files ? "change" : "add"
        files[path] = textOf(files[path] ?? "") + content
        report(type, path)
      }),

    readdir: listing,

    readdirWithTypes: (path) =>
      listing(path).pipe(
        Effect.map((names) =>
          names.map((name) => {
            const fullPath = path + "/" + name
            const isFile = fullPath in files
            const isLink = fullPath in links
            return { name, isFile, isDirectory: !isFile && !isLink }
          }),
        ),
      ),

    stat: (path) => {
      const at = target(path)
      const content = files[at]
      return content !== undefined
        ? Effect.succeed({
            size: bytesOf(content).length,
            isFile: true,
            isDirectory: false,
            mtime: new Date(),
            mode: modeOf(at, 0o644),
          })
        : dirs.has(at)
          ? Effect.succeed({
              size: 0,
              isFile: false,
              isDirectory: true,
              mtime: new Date(),
              mode: modeOf(at, 0o755),
            })
          : Effect.fail(new FileNotFoundError({ path }))
    },

    isSymbolicLink: (path) =>
      path in links
        ? Effect.succeed(true)
        : path in files || dirs.has(path)
          ? Effect.succeed(false)
          : Effect.fail(new FileNotFoundError({ path })),

    mkdir: (path, options) =>
      Effect.sync(() => {
        if (!dirs.has(path) && options?.mode !== undefined) modes.set(path, options.mode)
        dirs.add(path)
      }),

    rm: (path, _options?) =>
      Effect.sync(() => {
        const removed = Object.keys(files).filter(
          (key) => key === path || key.startsWith(path + "/"),
        )
        dirs.delete(path)
        modes.delete(path)
        // Also remove any descendant paths.
        for (const key of removed) delete files[key]
        for (const key of removed) report("unlink", key)
      }),

    copyFile: (src, dest) => {
      const content = files[src]
      return content !== undefined
        ? Effect.sync(() => {
            const type = dest in files ? "change" : "add"
            files[dest] = content
            report(type, dest)
          })
        : Effect.fail(new FileWriteError({ path: dest, cause: `source ${src} not found` }))
    },

    mkdtemp: (prefix) =>
      Effect.sync(() => {
        const tmpPath = `${prefix}${Math.random().toString(36).slice(2, 8)}`
        dirs.add(tmpPath)
        return tmpPath
      }),

    realpath: (path) => {
      const at = target(path)
      return at in files || dirs.has(at)
        ? Effect.succeed(at)
        : Effect.fail(new FileNotFoundError({ path }))
    },

    // Its links are followed only at the end of a path, so the paths as written are the real ones.
    isContainedInReal: (filePath, container) => Effect.succeed(isContainedIn(filePath, container)),

    walk: (dir) => {
      const under = (f: string) => f.startsWith(dir + "/") || f === dir
      const relative = (f: string) => (f.startsWith(dir + "/") ? f.slice(dir.length + 1) : f)
      const entries: WalkEntry[] = [
        ...Object.entries(files)
          .filter(([f]) => under(f))
          .map(([f, content]) => ({
            path: f,
            relativePath: relative(f),
            isFile: true,
            isDirectory: false,
            size: bytesOf(content).length,
          })),
        ...Object.keys(links)
          .filter(under)
          .map((f) => ({
            path: f,
            relativePath: relative(f),
            isFile: false,
            isDirectory: false,
            size: 0,
          })),
      ]
      return Stream.fromIterable(entries)
    },

    watch: (paths, options) =>
      Stream.callback<FileChangeEvent, FileWatchError>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const watch = {
              paths: [...paths],
              depth: options?.depth,
              report: (event: FileChangeEvent) => {
                Queue.offerUnsafe(queue, event)
              },
            }
            watches.add(watch)
            return watch
          }),
          (watch) => Effect.sync(() => watches.delete(watch)),
        ),
      ),
  }
}

function bytesOf(content: Content): Buffer {
  return typeof content === "string" ? Buffer.from(content) : Buffer.from(content)
}

/** The content as UTF-8 text, a byte that isn't UTF-8 replaced as Node's `readFile` does. */
function textOf(content: Content): string {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8")
}

/** The distinct first path segments under `path`, of `paths`, in insertion order. */
function childNames(paths: ReadonlyArray<string>, path: string): string[] {
  const names = paths
    .filter((f) => f.startsWith(path + "/"))
    // split always yields at least one segment.
    .map((f) => f.slice(path.length + 1).split("/")[0]!)
  return [...new Set(names)]
}
