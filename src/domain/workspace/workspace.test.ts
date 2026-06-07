import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  getWorkspaceDirs,
  readWorkspaceFile,
  getWorkspaceChanges,
  getWorkspaceTree,
} from "./workspace.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"
import { MAX_FILE_CONTENT_SIZE } from "../../types.ts"

describe("getWorkspaceDirs", () => {
  it("returns sorted subdirectory names", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/beta/file.txt": "content",
        "/workspace/alpha/file.txt": "content",
        "/workspace/root.txt": "content",
      },
    })

    const dirs = await Effect.runPromise(
      getWorkspaceDirs("/workspace").pipe(Effect.provide(layer)),
    )

    expect(dirs).toEqual(["alpha", "beta"])
  })

  it("excludes hidden directories", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/.hidden/file.txt": "content",
        "/workspace/visible/file.txt": "content",
      },
    })

    const dirs = await Effect.runPromise(
      getWorkspaceDirs("/workspace").pipe(Effect.provide(layer)),
    )

    expect(dirs).toEqual(["visible"])
  })
})

describe("readWorkspaceFile", () => {
  it("reads a text file with content and language", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/main.ts": "const x = 1",
      },
    })

    const result = await Effect.runPromise(
      readWorkspaceFile("/workspace", "main.ts").pipe(Effect.provide(layer)),
    )

    expect(result.content).toBe("const x = 1")
    expect(result.language).toBe("typescript")
    expect(result.isBinary).toBe(false)
    expect(result.isImage).toBe(false)
    expect(result.isTooLarge).toBe(false)
  })

  it("returns image as base64 data URI for png", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/icon.png": "fake-png-data",
      },
    })

    const result = await Effect.runPromise(
      readWorkspaceFile("/workspace", "icon.png").pipe(Effect.provide(layer)),
    )

    expect(result.isImage).toBe(true)
    expect(result.mimeType).toBe("image/png")
    expect(result.dataUri).toContain("data:image/png;base64,")
  })

  it("detects known binary extensions", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/archive.zip": "binary content",
      },
    })

    const result = await Effect.runPromise(
      readWorkspaceFile("/workspace", "archive.zip").pipe(Effect.provide(layer)),
    )

    expect(result.isBinary).toBe(true)
    expect(result.content).toBe("")
  })

  it("marks files above MAX_FILE_CONTENT_SIZE as isTooLarge without content", async () => {
    const layer = makeTestLayer({
      files: {
        // TestFileSystem reports stat.size = string length, so this is over cap.
        "/workspace/big.txt": "x".repeat(MAX_FILE_CONTENT_SIZE + 1),
      },
    })

    const result = await Effect.runPromise(
      readWorkspaceFile("/workspace", "big.txt").pipe(Effect.provide(layer)),
    )

    expect(result.isTooLarge).toBe(true)
    expect(result.content).toBe("")
    expect(result.size).toBeGreaterThan(MAX_FILE_CONTENT_SIZE)
  })

  it("classifies a file with NUL bytes as binary and omits content", async () => {
    const layer = makeTestLayer({
      files: {
        // Embedded NUL forces the probe to treat the file as binary even
        // though the extension is not in the binary list.
        "/workspace/data.bin-text": "hello\x00world",
      },
    })

    const result = await Effect.runPromise(
      readWorkspaceFile("/workspace", "data.bin-text").pipe(Effect.provide(layer)),
    )

    expect(result.isBinary).toBe(true)
    expect(result.content).toBe("")
    expect(result.isTooLarge).toBe(false)
  })
})

describe("getWorkspaceChanges", () => {
  it("returns empty changes when no git changes", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/file.txt": "content",
      },
      git: {
        status: () => Effect.succeed([]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toEqual([])
    expect(result.totalChanges).toBe(0)
    expect(result.tooManyChanges).toBe(false)
  })

  it("categorizes added files correctly", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/new-file.txt": "new content",
      },
      git: {
        status: () =>
          Effect.succeed([{ path: "new-file.txt", status: "??" }]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].changeType).toBe("added")
    expect(result.changes[0].newContent).toBe("new content")
  })

  it("categorizes deleted files correctly", async () => {
    const layer = makeTestLayer({
      files: {},
      git: {
        status: () =>
          Effect.succeed([{ path: "removed.txt", status: " D" }]),
        diff: () =>
          Effect.succeed([
            {
              path: "removed.txt",
              originalContent: "old content",
              additions: 0,
              deletions: 2,
              changeType: "modified",
              isBinary: false,
              diffTruncated: false,
            },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].changeType).toBe("deleted")
    expect(result.changes[0].originalContent).toBe("old content")
  })

  it("categorizes modified files correctly", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/changed.txt": "new version",
      },
      git: {
        status: () =>
          Effect.succeed([{ path: "changed.txt", status: " M" }]),
        diff: () =>
          Effect.succeed([
            {
              path: "changed.txt",
              originalContent: "old version",
              additions: 1,
              deletions: 1,
              changeType: "modified",
              isBinary: false,
              diffTruncated: false,
            },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].changeType).toBe("modified")
    expect(result.changes[0].newContent).toBe("new version")
    expect(result.changes[0].originalContent).toBe("old version")
  })

  it("handles renamed files", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/new-name.txt": "content",
      },
      git: {
        status: () =>
          Effect.succeed([
            { path: "old-name.txt -> new-name.txt", status: "R " },
          ]),
        diff: () => Effect.succeed([]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].path).toBe("new-name.txt")
  })

  it.each<[string, string, "added" | "deleted" | "modified"]>([
    ["??", "untracked", "added"],
    ["A ", "newly added", "added"],
    [" M", "worktree-modified", "modified"],
    ["M ", "staged-modified", "modified"],
    [" D", "deleted", "deleted"],
    ["D ", "staged-deleted", "deleted"],
    ["R ", "renamed", "modified"],
  ])("maps git status code '%s' (%s) to changeType '%s'", async (status, label, expected) => {
    void label
    const layer = makeTestLayer({
      files: { "/workspace/f.txt": "x" },
      git: {
        status: () => Effect.succeed([{ path: "f.txt", status }]),
        diff: () =>
          Effect.succeed([
            { path: "f.txt", originalContent: "old", additions: 1, deletions: 1, changeType: "modified", isBinary: false, diffTruncated: false },
          ]),
      },
    })
    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )
    expect(result.changes[0]?.changeType).toBe(expected)
  })

  it("skips diff for binary files", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/image.exe": "binary",
      },
      git: {
        status: () =>
          Effect.succeed([{ path: "image.exe", status: "??" }]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].isBinary).toBe(true)
    expect(result.changes[0].newContent).toBeUndefined()
  })

  it("treats a trailing-slash entry as a directory without reading it", async () => {
    // Git reports embedded git repos / untracked dirs as a single entry with a
    // trailing slash; reading one as a file throws EISDIR. Before the fix this
    // rejected the whole batch (the polled IPC error loop).
    const layer = makeTestLayer({
      files: {
        "/workspace/file.mdx": "modified content",
      },
      git: {
        status: () =>
          Effect.succeed([
            { path: "file.mdx", status: " M" },
            { path: "embedded-repo/", status: "??" },
          ]),
        diff: () =>
          Effect.succeed([
            { path: "file.mdx", originalContent: "old", additions: 1, deletions: 1, changeType: "modified", isBinary: false, diffTruncated: false },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    // Count stays consistent — the directory is kept in the list, not dropped.
    expect(result.totalChanges).toBe(2)
    expect(result.changes).toHaveLength(2)
    const dir = result.changes.find((c) => c.path === "embedded-repo/")
    expect(dir?.isDirectory).toBe(true)
    expect(dir?.additions).toBe(0)
    expect(dir?.newContent).toBeUndefined()
  })

  it("returns a directory entry (no diff) in single-file mode", async () => {
    // Exercises the getSingleFileDiff → populateDiffContent path.
    const layer = makeTestLayer({
      files: {},
      git: {
        status: () =>
          Effect.succeed([{ path: "embedded-repo/", status: "??" }]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace", "embedded-repo/").pipe(
        Effect.provide(layer),
      ),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].isDirectory).toBe(true)
    expect(result.changes[0].newContent).toBeUndefined()
  })

  it("degrades gracefully when an added file cannot be read", async () => {
    // The file is deliberately unregistered, so readFile fails — standing in
    // for a real-world EISDIR/EACCES/race. Before the fix the unguarded
    // "added" read rejected the whole batch.
    const layer = makeTestLayer({
      files: {},
      git: {
        status: () =>
          Effect.succeed([{ path: "vanished.txt", status: "??" }]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].changeType).toBe("added")
    expect(result.changes[0].additions).toBe(0)
    expect(result.changes[0].newContent).toBeUndefined()
  })
})

describe("getWorkspaceTree", () => {
  it("builds tree with correct file/folder hierarchy", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/readme.md": "# Hello",
        "/workspace/src/index.ts": "export {}",
      },
      git: {
        checkIgnored: () => Effect.succeed(new Set<string>()),
        getInfo: () =>
          Effect.succeed({
            branch: "main",
            refType: "branch" as const,
            remoteUrl: "https://github.com/test/repo",
            commitSha: "abc123",
          }),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceTree("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.tree.length).toBeGreaterThan(0)
    const names = result.tree.map((n) => n.name)
    expect(names).toContain("src")
    expect(names).toContain("readme.md")
  })

  it("skips .git directories", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/.git/config": "git config",
        "/workspace/file.txt": "content",
      },
      git: {
        checkIgnored: () => Effect.succeed(new Set<string>()),
        getInfo: () =>
          Effect.succeed({
            branch: "main",
            refType: "branch" as const,
            remoteUrl: "",
            commitSha: "",
          }),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceTree("/workspace").pipe(Effect.provide(layer)),
    )

    const names = result.tree.map((n) => n.name)
    expect(names).not.toContain(".git")
    expect(names).toContain("file.txt")
  })
})
