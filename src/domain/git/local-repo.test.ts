import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { inspectLocalRepo, resolveLocalRepoPath } from "./local-repo.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"
import type { TestLayerOptions } from "../../test-utils/TestLayer.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { GitError } from "../../errors/index.ts"

const WORKING_DIR = "/work/runbook"

const lsFiles = (names: string[]) => ({
  command: "git",
  args: ["ls-files"],
  outputLines: names,
  exitCode: 0,
})

/**
 * Run inspectLocalRepo against a test layer, creating `dirs` first so the
 * stubbed FileSystem reports them as directories (it only knows about
 * directories that were mkdir'd).
 */
const inspect = (
  dir: string,
  options: TestLayerOptions & { dirs?: string[] } = {},
) => {
  const { dirs = [], ...layerOptions } = options
  const layer = makeTestLayer(layerOptions)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem
      for (const d of dirs) yield* fs.mkdir(d)
      return yield* inspectLocalRepo(dir, WORKING_DIR)
    }).pipe(Effect.provide(layer)),
  )
}

/**
 * The failure text users see. GitError inherits Error but leaves `.message`
 * empty, so assertions read the tagged `stderr` field instead.
 */
const inspectFailure = async (
  dir: string,
  options: TestLayerOptions & { dirs?: string[] } = {},
): Promise<string> => {
  const { dirs = [], ...layerOptions } = options
  const layer = makeTestLayer(layerOptions)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem
      for (const d of dirs) yield* fs.mkdir(d)
      return yield* Effect.either(inspectLocalRepo(dir, WORKING_DIR))
    }).pipe(Effect.provide(layer)),
  )
  if (result._tag === "Right") throw new Error("expected inspectLocalRepo to fail")
  return result.left.stderr
}

describe("resolveLocalRepoPath", () => {
  it("keeps absolute paths", () => {
    expect(resolveLocalRepoPath("/home/me/infra", WORKING_DIR)).toBe("/home/me/infra")
  })

  it("resolves relative paths against the working directory", () => {
    expect(resolveLocalRepoPath("checkouts/infra", WORKING_DIR)).toBe(
      "/work/runbook/checkouts/infra",
    )
  })
})

describe("inspectLocalRepo", () => {
  it("describes a checkout outside the working directory", async () => {
    const info = await inspect("/home/me/infra", {
      dirs: ["/home/me/infra"],
      commands: [lsFiles(["main.tf", "vars.tf", "README.md"])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/infra"),
        getInfo: () =>
          Effect.succeed({
            branch: "main",
            refType: "branch" as const,
            remoteUrl: "https://github.com/acme/infra.git",
            commitSha: "abc123",
          }),
      },
    })

    expect(info.absolutePath).toBe("/home/me/infra")
    // Outside the working dir, the absolute path is the only sensible display form.
    expect(info.relativePath).toBe("/home/me/infra")
    expect(info.fileCount).toBe(3)
    expect(info.branch).toBe("main")
    expect(info.remoteUrl).toBe("https://github.com/acme/infra.git")
    expect(info.owner).toBe("acme")
    expect(info.repo).toBe("infra")
  })

  it("resolves the repository root when a subdirectory is selected", async () => {
    const info = await inspect("/home/me/infra/modules/vpc", {
      dirs: ["/home/me/infra/modules/vpc"],
      commands: [lsFiles(["main.tf"])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/infra"),
        getInfo: () => Effect.succeed({ branch: "main", refType: "branch" as const }),
      },
    })

    expect(info.absolutePath).toBe("/home/me/infra")
  })

  it("reports a path inside the working directory as relative", async () => {
    const info = await inspect("checkouts/infra", {
      dirs: ["/work/runbook/checkouts/infra"],
      commands: [lsFiles(["main.tf"])],
      git: {
        getRepoRoot: () => Effect.succeed("/work/runbook/checkouts/infra"),
        getInfo: () => Effect.succeed({ branch: "main", refType: "branch" as const }),
      },
    })

    expect(info.absolutePath).toBe("/work/runbook/checkouts/infra")
    expect(info.relativePath).toBe("checkouts/infra")
  })

  it("succeeds for a repo with no commits yet", async () => {
    const info = await inspect("/home/me/fresh", {
      dirs: ["/home/me/fresh"],
      commands: [lsFiles([])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/fresh"),
        getInfo: () =>
          Effect.fail(
            new GitError({ command: "git rev-parse", stderr: "no HEAD", exitCode: 128 }),
          ),
      },
    })

    expect(info.branch).toBe("")
    expect(info.fileCount).toBe(0)
    expect(info.owner).toBeUndefined()
  })

  it("falls back to a non-origin remote when there is no origin", async () => {
    const info = await inspect("/home/me/fork", {
      dirs: ["/home/me/fork"],
      commands: [
        { command: "git", args: ["remote"], outputLines: ["upstream"], exitCode: 0 },
        {
          command: "git",
          args: ["remote", "get-url", "upstream"],
          outputLines: ["git@github.com:acme/infra.git"],
          exitCode: 0,
        },
        lsFiles(["main.tf"]),
      ],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/fork"),
        // getInfo only looks at origin, which this checkout doesn't have.
        getInfo: () => Effect.succeed({ branch: "main", refType: "branch" as const }),
      },
    })

    expect(info.remoteUrl).toBe("git@github.com:acme/infra.git")
    expect(info.owner).toBe("acme")
    expect(info.repo).toBe("infra")
  })

  it("omits owner/repo when the repo has no remote", async () => {
    const info = await inspect("/home/me/local-only", {
      dirs: ["/home/me/local-only"],
      commands: [lsFiles(["a.txt"])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/local-only"),
        getInfo: () => Effect.succeed({ branch: "main", refType: "branch" as const }),
      },
    })

    expect(info.remoteUrl).toBeUndefined()
    expect(info.owner).toBeUndefined()
    expect(info.repo).toBeUndefined()
  })

  it("fails when the directory is not a git work tree", async () => {
    const stderr = await inspectFailure("/home/me/notes", {
      dirs: ["/home/me/notes"],
      git: {
        getRepoRoot: () =>
          Effect.fail(
            new GitError({
              command: "git rev-parse",
              stderr: "not a git repository",
              exitCode: 128,
            }),
          ),
      },
    })

    expect(stderr).toBe("Not a git repository: /home/me/notes")
  })

  it("fails when the directory does not exist", async () => {
    expect(await inspectFailure("/home/me/missing")).toBe(
      "Directory not found: /home/me/missing",
    )
  })

  it("fails when the path is a file", async () => {
    const stderr = await inspectFailure("/home/me/notes.txt", {
      files: { "/home/me/notes.txt": "hi" },
    })
    expect(stderr).toBe("Not a directory: /home/me/notes.txt")
  })

  it("fails when no directory was given", async () => {
    expect(await inspectFailure("   ")).toBe("No repository directory selected.")
  })
})
