import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import {
  containsPathTraversal,
  isAbsolutePath,
  isFilesystemRoot,
  isContainedIn,
  isContainedInReal,
  validateRelativePath,
  validateRelativePathIn,
} from "./path-validation.ts"

describe("containsPathTraversal", () => {
  it("detects .. at start", () => {
    expect(containsPathTraversal("../etc/passwd")).toBe(true)
  })

  it("detects .. in middle", () => {
    expect(containsPathTraversal("foo/../bar")).toBe(true)
  })

  it("detects standalone ..", () => {
    expect(containsPathTraversal("..")).toBe(true)
  })

  it("detects .. at end", () => {
    expect(containsPathTraversal("foo/..")).toBe(true)
  })

  it("detects Windows-style backslash traversal", () => {
    expect(containsPathTraversal("foo\\..\\bar")).toBe(true)
  })

  it("returns false for normal paths", () => {
    expect(containsPathTraversal("foo/bar")).toBe(false)
    expect(containsPathTraversal("./foo")).toBe(false)
    expect(containsPathTraversal("foo/bar/baz")).toBe(false)
  })

  it("returns false for .. inside a filename", () => {
    expect(containsPathTraversal("file..txt")).toBe(false)
  })
})

describe("isAbsolutePath", () => {
  it("returns true for absolute paths", () => {
    expect(isAbsolutePath("/foo")).toBe(true)
    expect(isAbsolutePath("/")).toBe(true)
  })

  it("returns false for relative paths", () => {
    expect(isAbsolutePath("foo/bar")).toBe(false)
    expect(isAbsolutePath("./foo")).toBe(false)
    expect(isAbsolutePath("")).toBe(false)
  })
})

describe("isFilesystemRoot", () => {
  it("returns true for /", () => {
    expect(isFilesystemRoot("/")).toBe(true)
  })

  it("returns false for non-root paths", () => {
    expect(isFilesystemRoot("/home")).toBe(false)
    expect(isFilesystemRoot("/usr/bin")).toBe(false)
  })
})

describe("isContainedIn", () => {
  it("returns true for child path", () => {
    expect(isContainedIn("/a/b/c", "/a/b")).toBe(true)
  })

  it("returns true for exact match", () => {
    expect(isContainedIn("/a/b", "/a/b")).toBe(true)
  })

  it("returns false for prefix-but-not-parent", () => {
    expect(isContainedIn("/a/bc", "/a/b")).toBe(false)
  })

  it("returns false when file is above container", () => {
    expect(isContainedIn("/a", "/a/b")).toBe(false)
  })
})

// Regression guard for the lexical-vs-realpath symlink-escape class
// (`sec-path-traversal`): renderer-supplied paths run through symlink-following
// fs ops, so a symlink planted inside the session root must not be allowed to
// dereference to a file outside it. These tests exercise real symlinks on a
// temp dir — the same gate every IPC read/write entry point now routes through.
describe("isContainedInReal", () => {
  let root: string
  let container: string
  let outside: string

  beforeAll(() => {
    // os.tmpdir() is itself often a symlink (e.g. macOS /var -> /private/var),
    // which is exactly the case where lexical comparison breaks and realpath
    // resolution is required on both sides.
    root = mkdtempSync(path.join(tmpdir(), "rb-pathtest-"))
    container = path.join(root, "session")
    outside = path.join(root, "outside")
    mkdirSync(container)
    mkdirSync(outside)
    writeFileSync(path.join(container, "real.txt"), "inside")
    writeFileSync(path.join(outside, "secret.txt"), "secret")
    // A symlink inside the container pointing OUT to the sibling dir.
    symlinkSync(outside, path.join(container, "escape-dir"))
    // A symlink inside the container pointing to a real file inside it.
    symlinkSync(path.join(container, "real.txt"), path.join(container, "inside-link"))
    // A dangling symlink inside the container pointing OUT (write-through escape).
    symlinkSync(path.join(outside, "ghost.txt"), path.join(container, "dangling-escape"))

    // Relative-target fixtures. The kernel resolves a relative link target
    // against the link's *real* parent and applies `..` after dereferencing
    // the prefix, so neither may be resolved lexically.
    mkdirSync(path.join(container, "deep", "a", "b"), { recursive: true })
    mkdirSync(path.join(outside, "deep"))
    // deep/a/b/up really is deep/.
    symlinkSync("../..", path.join(container, "deep", "a", "b", "up"))
    // Dangling, relative: from deep/ this is <root>/escaped-up.txt.
    symlinkSync("../../escaped-up.txt", path.join(container, "deep", "escape-up"))
    // Dangling, relative, stays inside: from deep/ this is <container>/future.txt.
    symlinkSync("../future.txt", path.join(container, "deep", "inside-dangling"))
    // s really is <root>/outside/deep, so s/.. is <root>/outside, not the container.
    symlinkSync("../outside/deep", path.join(container, "s"))
    symlinkSync("s/../escaped-dotdot.txt", path.join(container, "dangling-dotdot"))
    // A self-referencing symlink cycle.
    symlinkSync("loop", path.join(container, "loop"))
    // down-link really is a/b/c, so down-link/../.. is a/ for the kernel but
    // the container's parent once `..` is collapsed lexically.
    mkdirSync(path.join(container, "a", "b", "c"), { recursive: true })
    symlinkSync("a/b/c", path.join(container, "down-link"))
    // Dangling, relative, with `..` after a symlink in the target. POSIX
    // dereferences down-link before each `..` (<container>/future.txt);
    // Windows collapses the target lexically first (<root>/../future.txt).
    symlinkSync("down-link/../../../future.txt", path.join(container, "dangling-via-down-link"))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("allows a real file inside the container", async () => {
    expect(await isContainedInReal(path.join(container, "real.txt"), container)).toBe(true)
  })

  it("allows the container itself", async () => {
    expect(await isContainedInReal(container, container)).toBe(true)
  })

  it("allows a not-yet-existing write target inside the container", async () => {
    expect(await isContainedInReal(path.join(container, "new-output.txt"), container)).toBe(true)
  })

  it("allows a symlink inside the container that points to a file inside it", async () => {
    expect(await isContainedInReal(path.join(container, "inside-link"), container)).toBe(true)
  })

  it("rejects a path that escapes via a symlink to an existing outside target", async () => {
    const escaped = path.join(container, "escape-dir", "secret.txt")
    // The lexical check is fooled — this is the bug the realpath guard closes.
    expect(isContainedIn(escaped, container)).toBe(true)
    expect(await isContainedInReal(escaped, container)).toBe(false)
  })

  it("rejects a write through a dangling symlink that points outside", async () => {
    expect(await isContainedInReal(path.join(container, "dangling-escape"), container)).toBe(false)
  })

  it("rejects a plainly out-of-container path", async () => {
    expect(await isContainedInReal(path.join(outside, "secret.txt"), container)).toBe(false)
  })

  it("rejects a relative dangling symlink reached through a directory symlink", async () => {
    // Lexically the link sits in deep/a/b/up/, so ../../escaped-up.txt would be
    // deep/a/escaped-up.txt; a write actually lands in <root>/.
    const viaUp = path.join(container, "deep", "a", "b", "up", "escape-up")
    expect(await isContainedInReal(viaUp, container)).toBe(false)
  })

  it("rejects a dangling symlink whose target has `..` after a directory symlink", async () => {
    // s/../escaped-dotdot.txt collapses lexically to <container>/escaped-dotdot.txt,
    // but s/.. is <root>/outside.
    expect(await isContainedInReal(path.join(container, "dangling-dotdot"), container)).toBe(false)
  })

  it("rejects an input path with `..` after a directory symlink that points outside", async () => {
    // String concatenation keeps the `..` that path.join would collapse.
    const input = `${container}${path.sep}escape-dir${path.sep}..${path.sep}escaped.txt`
    expect(await isContainedInReal(input, container)).toBe(false)
  })

  it("rejects a symlink reached after `..` pops a not-yet-existing segment", async () => {
    // mkdir -p creates not-yet/, after which s is followed to <root>/outside/deep,
    // so s/.. is <root>/outside and the write lands in <root>/outside/x/.
    // Lexically this is <container>/x/new.txt, so only a walk that resumes
    // dereferencing once `..` empties the missing tail rejects it.
    const sep = path.sep
    const input = `${container}${sep}not-yet${sep}..${sep}s${sep}..${sep}x${sep}new.txt`
    expect(isContainedIn(input, container)).toBe(true)
    expect(await isContainedInReal(input, container)).toBe(false)
  })

  it("rejects an input path whose `..` escapes only once collapsed lexically", async () => {
    // The kernel reads this as <container>/a/secret.txt, but callers that
    // path.join/path.resolve before reading land on <root>/secret.txt.
    const input = `${container}${path.sep}down-link${path.sep}..${path.sep}..${path.sep}secret.txt`
    expect(await isContainedInReal(input, container)).toBe(false)
  })

  it("allows `..` after a directory symlink when both readings stay inside", async () => {
    // Kernel: <container>/a/b/new.txt. Lexical: <container>/new.txt.
    const input = `${container}${path.sep}down-link${path.sep}..${path.sep}new.txt`
    expect(await isContainedInReal(input, container)).toBe(true)
  })

  it("allows a relative dangling symlink that stays inside the container", async () => {
    expect(await isContainedInReal(path.join(container, "deep", "inside-dangling"), container)).toBe(true)
    const viaUp = path.join(container, "deep", "a", "b", "up", "inside-dangling")
    expect(await isContainedInReal(viaUp, container)).toBe(true)
  })

  it("applies `..` in a relative link target the way the host OS does", async () => {
    const link = path.join(container, "dangling-via-down-link")
    expect(await isContainedInReal(link, container)).toBe(process.platform !== "win32")
  })

  it("fails closed on a symlink cycle", async () => {
    expect(await isContainedInReal(path.join(container, "loop", "x.txt"), container)).toBe(false)
  })

  // The same directory has two spellings on a case-insensitive filesystem
  // (the macOS and Windows defaults); both must canonicalize to one.
  const caseInsensitive = tmpdir().toUpperCase() !== tmpdir() && existsSync(tmpdir().toUpperCase())
  const itCaseInsensitive = caseInsensitive ? it : it.skip
  itCaseInsensitive("matches a differently-cased spelling of the container", async () => {
    const target = path.join(container.toUpperCase(), "new-output.txt")
    expect(await isContainedInReal(target, container)).toBe(true)
  })
})

describe("validateRelativePath", () => {
  it("succeeds for valid relative path", async () => {
    await Effect.runPromise(validateRelativePath("foo/bar"))
  })

  it("succeeds (no-op) for empty string", async () => {
    await Effect.runPromise(validateRelativePath(""))
  })

  it("fails for absolute path", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePath("/absolute/path"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails for path with traversal", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePath("../escape"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("validateRelativePathIn", () => {
  it("succeeds for contained relative path", async () => {
    await Effect.runPromise(validateRelativePathIn("sub/file.txt", "/workspace"))
  })

  it("fails for empty path", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePathIn("", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails when resolved path escapes directory", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePathIn("../../etc/passwd", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
