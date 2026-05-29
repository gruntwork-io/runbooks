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
// pathologically deep set of dangling symlinks fails closed instead of
// looping forever. Mirrors the spirit of the kernel's SYMLOOP_MAX.
const SYMLINK_RESOLVE_LIMIT = 64

/**
 * Resolve `inputPath` to a canonical absolute path with every symlink in it
 * dereferenced.
 *
 * `fs.realpath` only resolves paths that fully exist, but containment checks
 * must also cover write targets that don't exist yet. So we `realpath` the
 * deepest existing ancestor — which dereferences every symlink in that prefix
 * — and re-append the not-yet-existing tail. A dangling symlink at the first
 * non-existing segment (which a write could be redirected *through*) is
 * dereferenced explicitly.
 *
 * Throws on symlink cycles / excessive indirection so callers fail closed.
 */
async function canonicalizePath(inputPath: string): Promise<string> {
  let current = path.resolve(inputPath)
  const tail: string[] = []
  for (let i = 0; i < SYMLINK_RESOLVE_LIMIT; i++) {
    try {
      const real = await fs.realpath(current)
      return tail.length === 0 ? real : path.join(real, ...tail)
    } catch {
      // `current` has no fully-real path. If it is itself a (possibly
      // dangling) symlink, follow it so the canonical location can't be
      // hidden behind an unresolved link; otherwise treat its last segment
      // as a literal, not-yet-created component and keep walking up.
      try {
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink()) {
          current = path.resolve(path.dirname(current), await fs.readlink(current))
          continue
        }
      } catch {
        // `current` truly doesn't exist; fall through to the walk-up below.
      }
      const parent = path.dirname(current)
      if (parent === current) {
        // Reached the filesystem root without an existing ancestor.
        return tail.length === 0 ? current : path.join(current, ...tail)
      }
      tail.unshift(path.basename(current))
      current = parent
    }
  }
  throw new Error(`path canonicalization exceeded symlink limit: ${inputPath}`)
}

/**
 * Like {@link isContainedIn}, but dereferences symlinks in both paths before
 * comparing. A symlink planted inside `container` that points outside it
 * therefore fails the check, closing the lexical-vs-realpath gap that lets
 * renderer-supplied paths escape the session root via symlink-following fs
 * ops. Fails closed (returns `false`) if either path can't be canonicalized.
 */
export async function isContainedInReal(filePath: string, container: string): Promise<boolean> {
  try {
    const [resolvedFile, resolvedContainer] = await Promise.all([
      canonicalizePath(filePath),
      canonicalizePath(container),
    ])
    return isContainedIn(resolvedFile, resolvedContainer)
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
