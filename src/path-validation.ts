import path from "path"
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
