import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { Effect, Either, Layer } from "effect"
import {
  getWorkspaceDirs,
  readWorkspaceFile,
  getWorkspaceChanges,
  getWorkspaceTree,
} from "./workspace.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"
import { MAX_FILE_CONTENT_SIZE } from "../../types.ts"
import { GitError } from "../../errors/index.ts"
import { buildCloneSteps } from "../git/cloneSteps.ts"
import type { DiffEntry } from "../../services/GitClient.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import type { ProcessSpawnerShape } from "../../services/ProcessSpawner.ts"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { GitCliClientLive } from "../../layers/GitCliClient.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

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

  it("counts an added file's lines as git does, not counting the final newline as a line", async () => {
    const layer = makeTestLayer({
      files: {
        "/workspace/terminated.txt": "a\nb\n",
        "/workspace/unterminated.txt": "a\nb",
        "/workspace/blank-last.txt": "a\n\n",
        "/workspace/crlf.txt": "a\r\nb\r\n",
      },
      git: {
        status: () =>
          Effect.succeed([
            { path: "terminated.txt", status: "??" },
            { path: "unterminated.txt", status: "??" },
            { path: "blank-last.txt", status: "??" },
            { path: "crlf.txt", status: "??" },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes.map((c) => [c.path, c.additions])).toEqual([
      ["terminated.txt", 2],
      ["unterminated.txt", 2],
      ["blank-last.txt", 2],
      ["crlf.txt", 2],
    ])
  })

  it("counts a deleted file's blank last line (git show lines joined with \\n)", async () => {
    const layer = makeTestLayer({
      files: {},
      git: {
        status: () => Effect.succeed([{ path: "removed.txt", status: " D" }]),
        // HEAD "x\n\n" comes back from `git show` as the lines ["x", ""].
        diff: () =>
          Effect.succeed([
            {
              path: "removed.txt",
              originalContent: "x\n",
              additions: 0,
              deletions: 2,
              changeType: "modified",
              isBinary: false,
            },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes[0].deletions).toBe(2)
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
            { path: "new-name.txt", origPath: "old-name.txt", status: "R " },
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

  it.each<[string, string, number, number]>([
    ["a pure rename", "one\ntwo\nthree\n", 0, 0],
    ["a rename with a line added", "one\ntwo\nthree\nfour\n", 1, 0],
    ["a rename with a line changed", "one\n2\nthree", 1, 1],
    ["a rename with a line moved", "two\nthree\none\n", 1, 1],
    ["a rename with CRLF line ends", "one\r\ntwo\r\nthree\r\n", 0, 0],
  ])("diffs %s against the old path's HEAD content", async (_label, onDisk, additions, deletions) => {
    // git diffs without rename detection, so it reports the new path as added
    // (no HEAD content, every line new) and the old path as deleted.
    const layer = makeTestLayer({
      files: { "/workspace/new-name.txt": onDisk },
      git: {
        status: () =>
          Effect.succeed([{ path: "new-name.txt", origPath: "old-name.txt", status: "R" }]),
        diff: () =>
          Effect.succeed([
            { path: "new-name.txt", additions: 3, deletions: 0, changeType: "modified", isBinary: false },
            { path: "old-name.txt", originalContent: "one\ntwo\nthree", additions: 0, deletions: 3, changeType: "modified", isBinary: false },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toEqual([
      expect.objectContaining({
        path: "new-name.txt",
        changeType: "modified",
        originalContent: "one\ntwo\nthree",
        newContent: onDisk,
        additions,
        deletions,
      }),
    ])
  })

  it("takes a renamed-then-deleted file's HEAD content from its old path", async () => {
    const layer = makeTestLayer({
      git: {
        status: () =>
          Effect.succeed([{ path: "new-name.txt", origPath: "old-name.txt", status: "RD" }]),
        diff: () =>
          Effect.succeed([
            { path: "old-name.txt", originalContent: "one\ntwo", additions: 0, deletions: 2, changeType: "modified", isBinary: false },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes[0]).toMatchObject({
      path: "new-name.txt",
      changeType: "deleted",
      originalContent: "one\ntwo",
      deletions: 2,
    })
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
            { path: "f.txt", originalContent: "old", additions: 1, deletions: 1, changeType: "modified", isBinary: false },
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
            { path: "file.mdx", originalContent: "old", additions: 1, deletions: 1, changeType: "modified", isBinary: false },
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

  it("diffs the whole batch with one git.diff call, not one per file", async () => {
    const diffCalls: Array<string | undefined> = []
    const layer = makeTestLayer({
      files: {
        "/workspace/a.txt": "a2",
        "/workspace/b.txt": "b2",
      },
      git: {
        status: () =>
          Effect.succeed([
            { path: "a.txt", status: " M" },
            { path: "b.txt", status: "M " },
            { path: "gone.txt", status: "D " },
          ]),
        diff: (_repoPath, filePath) => {
          diffCalls.push(filePath)
          return Effect.succeed([
            { path: "a.txt", originalContent: "a1", additions: 1, deletions: 1, changeType: "modified", isBinary: false },
            { path: "b.txt", originalContent: "b1", additions: 2, deletions: 3, changeType: "modified", isBinary: false },
            { path: "gone.txt", originalContent: "g1\ng2", additions: 0, deletions: 2, changeType: "modified", isBinary: false },
          ])
        },
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    // One whole-worktree diff (no filePath), shared by every entry.
    expect(diffCalls).toEqual([undefined])
    expect(result.changes.map((c) => [c.path, c.originalContent, c.additions, c.deletions])).toEqual([
      ["a.txt", "a1", 1, 1],
      ["b.txt", "b1", 2, 3],
      ["gone.txt", "g1\ng2", 0, 2],
    ])
  })

  it("keeps an empty HEAD original instead of dropping it", async () => {
    // A file that was empty at HEAD has original content "" — without it the
    // view can't render a before/after diff for the file.
    const layer = makeTestLayer({
      files: { "/workspace/was-empty.txt": "now filled" },
      git: {
        status: () =>
          Effect.succeed([
            { path: "was-empty.txt", status: " M" },
            { path: "empty-gone.txt", status: " D" },
          ]),
        diff: () =>
          Effect.succeed([
            { path: "was-empty.txt", originalContent: "", additions: 1, deletions: 0, changeType: "modified", isBinary: false },
            { path: "empty-gone.txt", originalContent: "", additions: 0, deletions: 0, changeType: "modified", isBinary: false },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes[0].originalContent).toBe("")
    expect(result.changes[1].originalContent).toBe("")
    expect(result.changes[1].deletions).toBe(0)
  })

  it("degrades a deleted file when git diff fails instead of failing the batch", async () => {
    // e.g. `git diff` failing on an odd repo state. The batch is polled every
    // 3s, so one git failure must not turn into an error loop.
    const layer = makeTestLayer({
      files: { "/workspace/new.txt": "hello" },
      git: {
        status: () =>
          Effect.succeed([
            { path: "gone.txt", status: " D" },
            { path: "new.txt", status: "??" },
          ]),
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(result.changes).toHaveLength(2)
    expect(result.changes[0]).toMatchObject({ path: "gone.txt", changeType: "deleted", deletions: 0 })
    expect(result.changes[0].originalContent).toBeUndefined()
    expect(result.changes[1].newContent).toBe("hello")
  })

  it("diffs each path alone when the whole-worktree diff fails, so only the failing one degrades", async () => {
    // e.g. a blobless sparse clone that can't reach its remote: git can't
    // fetch the HEAD blob of the one file edited outside the cone, which fails
    // the whole-worktree diff but not a diff of any other path.
    const diffCalls: Array<string | undefined> = []
    const perPath: Record<string, DiffEntry> = {
      "a.txt": { path: "a.txt", originalContent: "a1", additions: 1, deletions: 1, changeType: "modified", isBinary: false },
      "gone.txt": { path: "gone.txt", originalContent: "g1\ng2", additions: 0, deletions: 2, changeType: "modified", isBinary: false },
    }
    const layer = makeTestLayer({
      files: {
        "/workspace/a.txt": "a2",
        "/workspace/outside.txt": "o2",
      },
      git: {
        status: () =>
          Effect.succeed([
            { path: "a.txt", status: " M" },
            { path: "outside.txt", status: " M" },
            { path: "gone.txt", status: " D" },
          ]),
        diff: (_repoPath, filePath) => {
          diffCalls.push(filePath)
          const entry = filePath === undefined ? undefined : perPath[filePath]
          return entry
            ? Effect.succeed([entry])
            : Effect.fail(new GitError({ command: "diff", stderr: "fatal: could not fetch abc123 from promisor remote", exitCode: 128 }))
        },
      },
    })

    const result = await Effect.runPromise(
      getWorkspaceChanges("/workspace").pipe(Effect.provide(layer)),
    )

    expect(diffCalls).toEqual([undefined, "a.txt", "outside.txt", "gone.txt"])
    expect(result.changes.map((c) => [c.path, c.originalContent, c.additions, c.deletions, c.newContent])).toEqual([
      ["a.txt", "a1", 1, 1, "a2"],
      ["outside.txt", undefined, 0, 0, "o2"],
      ["gone.txt", "g1\ng2", 0, 2, undefined],
    ])
  })
})

describe("getWorkspaceChanges (real repo)", () => {
  // The mocked tests above hand back clean paths and whatever diff data they
  // like; these run the live git and file-system layers against a real repo.
  // The spawner is wrapped to record every git invocation.
  const SANDBOX_VARS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const
  const savedEnv: Record<string, string | undefined> = {}
  let root: string
  let repoPath: string
  let gitCalls: string[][]

  const recordingSpawner = Layer.effect(
    ProcessSpawner,
    Effect.map(ProcessSpawner, (inner): ProcessSpawnerShape => ({
      spawn: (command, args, options) => {
        if (command === "git") gitCalls.push(args)
        return inner.spawn(command, args, options)
      },
    })),
  ).pipe(Layer.provide(ChildProcessSpawnerLive))
  const liveLayer = Layer.mergeAll(
    NodeFileSystemLive,
    GitCliClientLive.pipe(Layer.provide(recordingSpawner)),
  )

  // `env: process.env` because bun's child_process otherwise starts git with
  // the environment the test process began with, not the sandbox below.
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
      { cwd, stdio: "pipe", env: process.env },
    )
  const git = (...args: string[]) => gitIn(repoPath, ...args)
  const write = (file: string, content: string) =>
    nodeFs.writeFileSync(nodePath.join(repoPath, file), content)

  beforeEach(() => {
    root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-workspace-changes-"))
    // git runs with a sandboxed HOME and no global or system config, here and
    // in the live layer, so the machine's git config can't change its output.
    for (const key of SANDBOX_VARS) savedEnv[key] = process.env[key]
    nodeFs.mkdirSync(nodePath.join(root, "home"))
    process.env.HOME = nodePath.join(root, "home")
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    repoPath = nodePath.join(root, "repo")
    nodeFs.mkdirSync(repoPath)
    gitCalls = []
    git("init")
  })

  afterEach(() => {
    for (const key of SANDBOX_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    nodeFs.rmSync(root, { recursive: true, force: true })
  })

  it("reports unusual paths verbatim and diffs staged changes against HEAD", async () => {
    write("my file.txt", "one\n")
    write("café.txt", "one\n")
    write("staged.txt", "one\n")
    write("gone.txt", "g1\ng2\n")
    git("add", ".")
    git("commit", "-m", "initial")

    write("my file.txt", "one\ntwo\n")
    write("café.txt", "uno\n")
    write("staged.txt", "one\nstaged\n")
    git("add", "staged.txt")
    git("rm", "-q", "gone.txt")
    write("new file.txt", "fresh\n")

    const result = await Effect.runPromise(
      getWorkspaceChanges(repoPath).pipe(Effect.provide(liveLayer)),
    )
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]))

    expect(Object.keys(byPath).sort()).toEqual([
      "café.txt",
      "gone.txt",
      "my file.txt",
      "new file.txt",
      "staged.txt",
    ])
    expect(byPath["my file.txt"]).toMatchObject({
      changeType: "modified",
      additions: 1,
      deletions: 0,
      originalContent: "one",
      newContent: "one\ntwo\n",
    })
    expect(byPath["café.txt"]).toMatchObject({
      changeType: "modified",
      additions: 1,
      deletions: 1,
      originalContent: "one",
      newContent: "uno\n",
    })
    // Fully staged: a worktree-vs-index diff reports 0/0 and no original.
    expect(byPath["staged.txt"]).toMatchObject({
      changeType: "modified",
      additions: 1,
      deletions: 0,
      originalContent: "one",
    })
    expect(byPath["gone.txt"]).toMatchObject({
      changeType: "deleted",
      deletions: 2,
      originalContent: "g1\ng2",
    })
    expect(byPath["new file.txt"]).toMatchObject({
      changeType: "added",
      newContent: "fresh\n",
    })
  })

  it("runs one git diff per poll plus one HEAD read per changed file", async () => {
    const files = ["a.tf", "b.tf", "c.tf", "d.tf", "e.tf"]
    for (const f of files) write(f, "before\n")
    git("add", ".")
    git("commit", "-m", "initial")
    for (const f of files) write(f, "after\n")

    const result = await Effect.runPromise(
      getWorkspaceChanges(repoPath).pipe(Effect.provide(liveLayer)),
    )

    expect(result.changes.map((c) => c.originalContent)).toEqual(files.map(() => "before"))
    // Previously each file cost its own numstat, show and (discarded) raw diff.
    expect(gitCalls.filter((args) => args[0] === "diff")).toHaveLength(1)
    expect(gitCalls.filter((args) => args[0] === "show")).toHaveLength(files.length)
  })

  it("skips the HEAD read for paths added relative to HEAD", async () => {
    write("mod.tf", "before\n")
    write("old.tf", "moved\n")
    git("add", ".")
    git("commit", "-m", "initial")
    write("mod.tf", "after\n")
    // Both have no HEAD version, so a `git show` for either is certain to fail:
    // a staged new file, and the new side of a staged rename (--no-renames
    // reports it as added, and the old side as deleted).
    write("new.tf", "fresh\n")
    git("add", "new.tf")
    git("mv", "old.tf", "renamed.tf")

    const result = await Effect.runPromise(
      getWorkspaceChanges(repoPath).pipe(Effect.provide(liveLayer)),
    )
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]))

    expect(byPath["mod.tf"]).toMatchObject({ changeType: "modified", originalContent: "before" })
    expect(byPath["new.tf"]).toMatchObject({ changeType: "added", newContent: "fresh\n" })
    // The rename's original is the old side's HEAD content, already read.
    expect(byPath["renamed.tf"]).toMatchObject({ changeType: "modified", originalContent: "moved" })
    expect(gitCalls.filter((args) => args[0] === "diff")).toHaveLength(1)
    // Only paths that exist in HEAD are read: the modified file and the old
    // side of the rename. new.tf and renamed.tf cost nothing.
    const shownPaths = gitCalls
      .filter((args) => args[0] === "show")
      .map((args) => args[1].slice(args[1].indexOf(":") + 1))
    expect(shownPaths.sort()).toEqual(["mod.tf", "old.tf"])
  })

  it("diffs a staged rename against its old path's HEAD content", async () => {
    write("old.tf", "a\nb\n")
    write("same.tf", "kept\n")
    git("add", ".")
    git("commit", "-m", "initial")
    git("mv", "old.tf", "new name.tf")
    write("new name.tf", "a\nb\nc\n")
    git("mv", "same.tf", "moved.tf")

    const bulk = await Effect.runPromise(
      getWorkspaceChanges(repoPath).pipe(Effect.provide(liveLayer)),
    )
    const byPath = Object.fromEntries(bulk.changes.map((c) => [c.path, c]))

    // Without the old side the view has no "before" and says the diff is
    // unavailable; git's own counts (+3/-0, +1/-0) treat each file as new.
    expect(byPath["new name.tf"]).toMatchObject({
      changeType: "modified",
      originalContent: "a\nb",
      newContent: "a\nb\nc\n",
      additions: 1,
      deletions: 0,
    })
    expect(byPath["moved.tf"]).toMatchObject({
      changeType: "modified",
      originalContent: "kept",
      additions: 0,
      deletions: 0,
    })
    // "Load diff" for one file gives the same answer.
    const single = await Effect.runPromise(
      getWorkspaceChanges(repoPath, "new name.tf").pipe(Effect.provide(liveLayer)),
    )
    expect(single.changes[0]).toMatchObject(byPath["new name.tf"])
  })

  it("diffs a staged change since put back in the worktree as unchanged", async () => {
    write("back.tf", "a\nb\n")
    write("crlf.tf", "c\r\nd\r\n")
    write("edited.tf", "e\n")
    git("add", ".")
    git("commit", "-m", "initial")
    write("back.tf", "a\nB\n")
    write("crlf.tf", "c\r\nD\r\n")
    git("add", "back.tf", "crlf.tf")
    write("back.tf", "a\nb\n")
    write("crlf.tf", "c\r\nd\r\n")
    write("edited.tf", "e2\n")
    // status lists back.tf and crlf.tf, but they match HEAD again, so the
    // whole-worktree diff against HEAD has no record of them.
    expect(git("status", "--porcelain=v1").toString()).toBe("MM back.tf\nMM crlf.tf\n M edited.tf\n")

    const result = await Effect.runPromise(
      getWorkspaceChanges(repoPath).pipe(Effect.provide(liveLayer)),
    )
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]))

    // Without an original the view says the diff is unavailable. The original
    // takes the form HEAD content always has (`git show` lines joined with
    // "\n"), or the view reads a final newline as one more line.
    expect(byPath["back.tf"]).toMatchObject({
      changeType: "modified",
      originalContent: "a\nb",
      newContent: "a\nb\n",
      additions: 0,
      deletions: 0,
    })
    expect(byPath["crlf.tf"]).toMatchObject({
      changeType: "modified",
      originalContent: "c\nd",
      newContent: "c\r\nd\r\n",
      additions: 0,
      deletions: 0,
    })
    expect(byPath["edited.tf"]).toMatchObject({ originalContent: "e", additions: 1, deletions: 1 })
    expect(gitCalls.filter((args) => args[0] === "diff")).toHaveLength(1)
  })

  it("keeps the other diffs in a blobless sparse clone that can't fetch one blob", async () => {
    // A GitClone with a repo path: a blobless, cone-mode sparse checkout of
    // modules/vpc. A later block edits a tracked file outside the cone, whose
    // HEAD blob was never downloaded, and the remote can't be reached (gone
    // here; in the app, e.g. a private repo the poll holds no token for).
    const origin = nodePath.join(root, "origin")
    for (const dir of ["vpc", "eks"]) {
      nodeFs.mkdirSync(nodePath.join(origin, "modules", dir), { recursive: true })
      nodeFs.writeFileSync(nodePath.join(origin, "modules", dir, "main.tf"), `# ${dir}\n`)
    }
    gitIn(origin, "init")
    gitIn(origin, "config", "uploadpack.allowFilter", "true")
    gitIn(origin, "add", ".")
    gitIn(origin, "commit", "-m", "initial")
    const work = nodePath.join(root, "work")
    const steps = Either.getOrThrow(buildCloneSteps(`file://${origin}`, work, { repoPath: "modules/vpc" }))
    for (const step of steps) gitIn(root, ...step.args)
    nodeFs.renameSync(origin, nodePath.join(root, "origin-gone"))

    nodeFs.writeFileSync(nodePath.join(work, "modules", "vpc", "main.tf"), "# vpc, edited\n")
    nodeFs.mkdirSync(nodePath.join(work, "modules", "eks"))
    nodeFs.writeFileSync(nodePath.join(work, "modules", "eks", "main.tf"), "# eks, edited\n")

    const result = await Effect.runPromise(
      getWorkspaceChanges(work).pipe(Effect.provide(liveLayer)),
    )
    const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]))

    expect(Object.keys(byPath).sort()).toEqual(["modules/eks/main.tf", "modules/vpc/main.tf"])
    expect(byPath["modules/vpc/main.tf"]).toMatchObject({
      changeType: "modified",
      additions: 1,
      deletions: 1,
      originalContent: "# vpc",
    })
    // Only the file git can't diff goes without, and it still lists.
    expect(byPath["modules/eks/main.tf"]).toMatchObject({
      changeType: "modified",
      additions: 0,
      deletions: 0,
      newContent: "# eks, edited\n",
    })
    expect(byPath["modules/eks/main.tf"].originalContent).toBeUndefined()
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
