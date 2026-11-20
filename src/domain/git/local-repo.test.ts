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

const gitVersion = (output: string) => ({
  command: "git",
  args: ["--version"],
  outputLines: [output],
  exitCode: 0,
})

/**
 * A layer whose git reports a current version unless the test's own
 * `commands` answer `git --version` first.
 */
const layerFor = (options: TestLayerOptions) =>
  makeTestLayer({
    ...options,
    commands: [...(options.commands ?? []), gitVersion("git version 2.54.0")],
  })

/**
 * Run inspectLocalRepo against a test layer, creating `dirs` first so the
 * stubbed FileSystem reports them as directories (it only knows about
 * directories that were mkdir'd).
 */
const inspect = (dir: string, options: TestLayerOptions & { dirs?: string[] } = {}) => {
  const { dirs = [], ...layerOptions } = options
  const layer = layerFor(layerOptions)
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
  const layer = layerFor(layerOptions)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem
      for (const d of dirs) yield* fs.mkdir(d)
      return yield* Effect.result(inspectLocalRepo(dir, WORKING_DIR))
    }).pipe(Effect.provide(layer)),
  )
  if (result._tag === "Success") throw new Error("expected inspectLocalRepo to fail")
  return result.failure.stderr
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

  it("succeeds for a repo with no commits yet, and says so", async () => {
    const info = await inspect("/home/me/fresh", {
      dirs: ["/home/me/fresh"],
      commands: [lsFiles([])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/fresh"),
        getInfo: () =>
          Effect.fail(new GitError({ command: "git rev-parse", stderr: "no HEAD", exitCode: 128 })),
        hasCommits: () => Effect.succeed(false),
      },
    })

    expect(info.branch).toBe("")
    expect(info.fileCount).toBe(0)
    expect(info.owner).toBeUndefined()
    // The empty branch alone can't be trusted to mean "empty repo" — callers
    // need this flag to know a base branch has to be seeded before a PR.
    expect(info.hasCommits).toBe(false)
  })

  it("treats a repo it can't query as having history, never as empty", async () => {
    const info = await inspect("/home/me/odd", {
      dirs: ["/home/me/odd"],
      commands: [lsFiles([])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/odd"),
        getInfo: () => Effect.succeed({ branch: "main", refType: "branch" as const }),
        hasCommits: () =>
          Effect.fail(new GitError({ command: "git rev-parse", stderr: "boom", exitCode: 1 })),
      },
    })

    // Guessing "empty" here would offer to seed a branch over a repo whose
    // state we simply failed to read.
    expect(info.hasCommits).toBe(true)
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

  it("never returns a token embedded in the remote URL", async () => {
    // A checkout cloned with its token in the URL keeps it in .git/config;
    // the remote URL is shown in the UI, so it must come back clean.
    const secret = "glpat-SECRET-TOKEN-0123456789"
    const viaOrigin = await inspect("/home/me/infra", {
      dirs: ["/home/me/infra"],
      commands: [lsFiles(["main.tf"])],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/infra"),
        getInfo: () =>
          Effect.succeed({
            branch: "main",
            refType: "branch" as const,
            remoteUrl: `https://oauth2:${secret}@gitlab.example.com/acme/infra.git`,
          }),
      },
    })
    const viaFallback = await inspect("/home/me/fork", {
      dirs: ["/home/me/fork"],
      commands: [
        { command: "git", args: ["remote"], outputLines: ["upstream"], exitCode: 0 },
        {
          command: "git",
          args: ["remote", "get-url", "upstream"],
          outputLines: [`https://x-access-token:${secret}@github.com/acme/infra.git`],
          exitCode: 0,
        },
        lsFiles(["main.tf"]),
      ],
      git: {
        getRepoRoot: () => Effect.succeed("/home/me/fork"),
        getInfo: () => Effect.succeed({ branch: "main", refType: "branch" as const }),
      },
    })

    expect(viaOrigin.remoteUrl).toBe("https://gitlab.example.com/acme/infra.git")
    expect(viaFallback.remoteUrl).toBe("https://github.com/acme/infra.git")
    expect(viaFallback.owner).toBe("acme")
    expect(viaFallback.repo).toBe("infra")
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

  describe("git version", () => {
    // getRepoRoot is the first git to run in the directory. Left unconfigured,
    // it fails the test with "Not a git repository" if it is ever reached.
    const repoRootCalls = (version: string | undefined) => {
      let calls = 0
      const failure = inspectFailure("/home/me/infra", {
        dirs: ["/home/me/infra"],
        commands: version === undefined ? [] : [gitVersion(version)],
        git: {
          getRepoRoot: () => {
            calls++
            return Effect.succeed("/home/me/infra")
          },
        },
      })
      return failure.then((stderr) => ({ stderr, calls }))
    }

    it("accepts a git that ignores safe.bareRepository when no bare repository is in the way", async () => {
      // Ubuntu 22.04's git: it takes config from the environment, but ignores
      // safe.bareRepository, so the check is done before git runs.
      const info = await inspect("/home/me/infra", {
        dirs: ["/home/me/infra", "/home/me/infra/.git"],
        commands: [gitVersion("git version 2.34.1"), lsFiles(["main.tf"])],
        git: { getRepoRoot: () => Effect.succeed("/home/me/infra") },
      })
      expect(info.absolutePath).toBe("/home/me/infra")
    })

    describe("with a git that ignores safe.bareRepository", () => {
      const bareLike = (dir: string) => [dir, `${dir}/objects`, `${dir}/refs`]
      const run = (selected: string, dirs: string[], head: string) => {
        let calls = 0
        return inspectFailure(selected, {
          dirs,
          files: { [head]: "ref: refs/heads/main\n" },
          commands: [gitVersion("git version 2.34.1")],
          git: {
            getRepoRoot: () => {
              calls++
              return Effect.succeed(selected)
            },
          },
        }).then((stderr) => ({ stderr, calls }))
      }

      it("refuses a selected directory that looks like a bare repository, before running git there", async () => {
        const { stderr, calls } = await run(
          "/home/me/clone/evil",
          bareLike("/home/me/clone/evil"),
          "/home/me/clone/evil/HEAD",
        )
        expect(stderr).toContain("/home/me/clone/evil looks like a bare Git repository")
        expect(stderr).toContain("update Git to 2.38 or later")
        expect(calls).toBe(0)
      })

      it("refuses a subdirectory of a bare-looking directory that git would reach before a .git", async () => {
        const dirs = [
          ...bareLike("/home/me/clone/evil"),
          "/home/me/clone/evil/refs/heads",
          "/home/me/clone/.git",
        ]
        const { stderr, calls } = await run(
          "/home/me/clone/evil/refs/heads",
          dirs,
          "/home/me/clone/evil/HEAD",
        )
        expect(stderr).toContain("/home/me/clone/evil looks like a bare Git repository")
        expect(calls).toBe(0)
      })

      it("ignores a bare-looking directory above the work tree's .git", async () => {
        const dirs = [...bareLike("/home/me"), "/home/me/infra", "/home/me/infra/.git"]
        const info = await inspect("/home/me/infra", {
          dirs,
          files: { "/home/me/HEAD": "ref: refs/heads/main\n" },
          commands: [gitVersion("git version 2.34.1"), lsFiles(["main.tf"])],
          git: { getRepoRoot: () => Effect.succeed("/home/me/infra") },
        })
        expect(info.absolutePath).toBe("/home/me/infra")
      })

      it("needs all of HEAD, objects and refs to call a directory bare", async () => {
        const dirs = ["/home/me/infra", "/home/me/infra/objects", "/home/me/infra/.git"]
        const info = await inspect("/home/me/infra", {
          dirs,
          files: { "/home/me/infra/HEAD": "ref: refs/heads/main\n" },
          commands: [gitVersion("git version 2.34.1"), lsFiles(["main.tf"])],
          git: { getRepoRoot: () => Effect.succeed("/home/me/infra") },
        })
        expect(info.absolutePath).toBe("/home/me/infra")
      })
    })

    it("refuses a git too old to take config from the environment", async () => {
      const { stderr, calls } = await repoRootCalls("git version 2.30.2")
      expect(stderr).toContain("Found Git 2.30.2")
      expect(calls).toBe(0)
    })

    it("refuses a git whose version it can't read", async () => {
      const { stderr, calls } = await repoRootCalls("git: unexpected output")
      expect(stderr).toBe(
        "Could not read the Git version. Using a local checkout needs Git 2.31 or later.",
      )
      expect(calls).toBe(0)
    })

    it.each([
      ["git version 2.38.0"],
      ["git version 2.39.5 (Apple Git-154)"],
      ["git version 2.47.0.windows.1"],
    ])("accepts %s", async (version) => {
      const info = await inspect("/home/me/infra", {
        dirs: ["/home/me/infra"],
        commands: [gitVersion(version), lsFiles(["main.tf"])],
        git: { getRepoRoot: () => Effect.succeed("/home/me/infra") },
      })
      expect(info.absolutePath).toBe("/home/me/infra")
    })
  })

  it("fails when the directory does not exist", async () => {
    expect(await inspectFailure("/home/me/missing")).toBe("Directory not found: /home/me/missing")
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
