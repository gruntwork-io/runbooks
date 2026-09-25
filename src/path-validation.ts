import path from "path"
import { promises as fs } from "node:fs"
import { Effect } from "effect"
import { PathTraversalError, PathValidationError } from "./errors/index.ts"

export function containsPathTraversal(p: string): boolean {
  const segments = p.split(/[/\\]/)
  return segments.some((s) => s === "..")
}

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p)
}

export function isFilesystemRoot(p: string): boolean {
  const normalized = path.resolve(p)
  return normalized === "/" || /^[a-zA-Z]:\\?$/.test(normalized)
}

export function isContainedIn(filePath: string, container: string): boolean {
  const resolved = path.resolve(filePath)
  const containerResolved = path.resolve(container)
  return resolved.startsWith(containerResolved + path.sep) || resolved === containerResolved
}

// Bound the manual symlink chasing in `canonicalizePath` so a cyclic or
// pathologically deep set of symlinks fails closed instead of looping
// forever. Mirrors the spirit of the kernel's SYMLOOP_MAX.
const SYMLINK_RESOLVE_LIMIT = 64

// Only win32 treats `\` as a separator; on POSIX it is a legal filename
// character, and splitting on it would disagree with the kernel.
const SEGMENT_SEPARATOR = path.sep === "\\" ? /[\\/]+/ : /\/+/

function splitSegments(p: string): string[] {
  return p.slice(path.parse(p).root.length).split(SEGMENT_SEPARATOR)
}

/**
 * Resolve `inputPath` to a canonical absolute path with every symlink in it
 * dereferenced.
 *
 * Walks the path one component at a time, the way the kernel does: each
 * existing prefix is `lstat`ed, a symlink's target is spliced into the
 * components still to walk (a relative target therefore resolves against the
 * link's *real* parent), and `..` is applied to the already-dereferenced
 * prefix. Nothing is collapsed lexically first, because `<symlink>/..` is the
 * symlink target's parent, not the symlink's.
 *
 * Containment checks must also cover write targets that don't exist yet, so
 * components past the deepest existing prefix are kept as a literal tail. A
 * `..` pops that tail first, and walking resumes once it is empty, since a
 * `mkdir -p` would create the missing directory and then follow whatever
 * comes after the `..`. The existing prefix is finally `realpath`ed so its
 * spelling (case on case-insensitive filesystems) matches other canonical
 * paths.
 *
 * Throws on symlink cycles / excessive indirection so callers fail closed.
 */
async function canonicalizePath(inputPath: string): Promise<string> {
  const abs = path.isAbsolute(inputPath) ? inputPath : `${process.cwd()}${path.sep}${inputPath}`
  // Stack of components still to walk, next one on top.
  const pending = splitSegments(abs).reverse()
  // Deepest existing prefix, with every symlink in it already dereferenced.
  let resolved = path.parse(abs).root
  // Components past `resolved` that don't exist yet.
  const tail: string[] = []
  let links = 0
  while (pending.length > 0) {
    const segment = pending.pop()!
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (tail.length > 0) tail.pop()
      else resolved = path.dirname(resolved)
      continue
    }
    if (tail.length > 0) {
      tail.push(segment)
      continue
    }
    const next = path.join(resolved, segment)
    const stat = await fs.lstat(next).catch(() => null)
    if (!stat) {
      tail.push(segment)
      continue
    }
    if (stat.isSymbolicLink()) {
      if (++links > SYMLINK_RESOLVE_LIMIT) {
        throw new Error(`path canonicalization exceeded symlink limit: ${inputPath}`)
      }
      const target = await fs.readlink(next)
      const targetRoot = path.parse(target).root
      if (targetRoot) resolved = path.resolve(resolved, targetRoot)
      pending.push(...splitSegments(target).reverse())
      continue
    }
    resolved = next
  }
  const real = await fs.realpath(resolved)
  return tail.length === 0 ? real : path.join(real, ...tail)
}

/**
 * Like {@link isContainedIn}, but dereferences symlinks in both paths before
 * comparing. A symlink planted inside `container` that points outside it
 * therefore fails the check, closing the lexical-vs-realpath gap that lets
 * renderer-supplied paths escape the session root via symlink-following fs
 * ops. Fails closed (returns `false`) if either path can't be canonicalized.
 *
 * A `..` in `filePath` has two readings, and callers use both: some hand the
 * raw path to fs, where the kernel applies `..` after dereferencing the prefix
 * (`<link>/..` is the link target's parent), while others normalize it
 * lexically first (`path.join`/`path.resolve`, where `<link>/..` is the
 * link's own parent) and read that instead. The two can land in different
 * places, so `filePath` must be contained under both readings.
 */
export async function isContainedInReal(filePath: string, container: string): Promise<boolean> {
  try {
    const [asKernel, asLexical, resolvedContainer] = await Promise.all([
      canonicalizePath(filePath),
      canonicalizePath(path.resolve(filePath)),
      canonicalizePath(container),
    ])
    return isContainedIn(asKernel, resolvedContainer) && isContainedIn(asLexical, resolvedContainer)
  } catch {
    return false
  }
}

export const validateRelativePath = (p: string) =>
  Effect.gen(function* () {
    if (!p) return
    if (isAbsolutePath(p)) {
      return yield* Effect.fail(new PathValidationError({ path: p, message: "path must be relative" }))
    }
    if (containsPathTraversal(p)) {
      return yield* Effect.fail(new PathTraversalError({ path: p, message: "path contains '..' traversal" }))
    }
  })

export const validateRelativePathIn = (p: string, dir: string) =>
  Effect.gen(function* () {
    if (!p) {
      return yield* Effect.fail(new PathValidationError({ path: p, message: "path must not be empty" }))
    }
    yield* validateRelativePath(p)
    const resolved = path.resolve(dir, p)
    if (!isContainedIn(resolved, dir)) {
      return yield* Effect.fail(
        new PathTraversalError({ path: p, message: `resolved path escapes directory: ${dir}` }),
      )
    }
  })
