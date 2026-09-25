/**
 * Live implementation of the GitClient service using ProcessSpawner.
 *
 * This layer depends on ProcessSpawner, so it uses Layer.effect to pull
 * the spawner from context.
 */
import * as path from "node:path"
import { Effect, Layer, Stream, Chunk } from "effect"
import { GitClient } from "../services/GitClient.ts"
import type {
  GitClientShape,
  CloneOptions,
  CloneResult,
  PushOptions,
  DiffEntry,
  StatusEntry,
  GitInfo,
  CommitOptions,
} from "../services/GitClient.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { GitError } from "../errors/index.ts"
import { injectTokenIntoUrl } from "../domain/git/url.ts"
import { gitSpawnEnv } from "../domain/git/env.ts"

/**
 * Run a git command, collect all output, and return stdout lines.
 * Fails with GitError if the exit code is non-zero.
 *
 * `env` overrides the spawn environment; defaults to `gitSpawnEnv()`. Callers
 * that need extra variables (e.g. a fallback committer identity) build on top of
 * `gitSpawnEnv()` so PATH/HOME/SSH_AUTH_SOCK and the no-prompt guards survive.
 */
function runGit(
  spawner: ProcessSpawner["Type"],
  args: string[],
  cwd: string,
  stdin?: string,
  env?: Record<string, string | undefined>,
) {
  return Effect.gen(function* () {
    const proc = yield* spawner.spawn("git", args, { cwd, stdin, env: env ?? gitSpawnEnv() })
    const chunks = yield* Stream.runCollect(proc.output)
    const lines = Chunk.toArray(chunks)
    const code = yield* proc.exitCode

    if (code !== 0) {
      const pick = (source: "stderr" | "stdout") =>
        lines
          .filter((l) => l.source === source)
          .map((l) => l.line)
          .join("\n")
      // Some git failures report only on stdout — notably `git commit` printing
      // "nothing to commit, working tree clean" and exiting 1. Fall back to
      // stdout so the real reason surfaces instead of a bare "exit 1".
      const stderr = pick("stderr") || pick("stdout")
      return yield* Effect.fail(
        new GitError({
          command: `git ${args.join(" ")}`,
          stderr,
          exitCode: code,
        }),
      )
    }

    return lines.filter((l) => l.source === "stdout").map((l) => l.line)
  })
}

/**
 * Whether the repo can resolve a committer identity from git config in *any*
 * scope (local, global, or system). `git config <key>` exits non-zero when the
 * key is unset, which `runGit` surfaces as a GitError — caught here as "not
 * configured". Used to decide whether a fallback author identity is needed.
 */
function hasConfiguredIdentity(spawner: ProcessSpawner["Type"], repoPath: string) {
  return Effect.gen(function* () {
    const isSet = (key: string) =>
      runGit(spawner, ["config", key], repoPath).pipe(
        Effect.map((lines) => lines.join("").trim().length > 0),
        Effect.catchAll(() => Effect.succeed(false)),
      )
    return (yield* isSet("user.name")) && (yield* isSet("user.email"))
  })
}

/**
 * Split the output of a `-z` git command into its NUL-terminated fields. With
 * -z git prints paths verbatim instead of C-quoting spaces and non-ASCII. runGit
 * hands back readline lines, so a field that contains a newline arrives split;
 * joining on "\n" restores it before splitting on NUL.
 */
function nulFields(lines: string[]): string[] {
  return lines.join("\n").split("\0").filter((f) => f.length > 0)
}

/**
 * Resolve HEAD to a commit SHA, or undefined on an unborn branch (a repo with
 * no commits yet). `--verify --quiet` exits 1 only when HEAD resolves to
 * nothing; any other failure (not a repo, spawn error) propagates.
 */
function resolveHead(spawner: ProcessSpawner["Type"], repoPath: string) {
  return runGit(spawner, ["rev-parse", "--verify", "--quiet", "HEAD"], repoPath).pipe(
    Effect.map((lines): string | undefined => lines[0]?.trim() || undefined),
    Effect.catchTag("GitError", (e) =>
      e.exitCode === 1 ? Effect.succeed(undefined) : Effect.fail(e),
    ),
  )
}

/** Max concurrent `git show` reads per diff, so a big change set can't fork hundreds of gits. */
const SHOW_CONCURRENCY = 8

function makeGitClient(spawner: ProcessSpawner["Type"]): GitClientShape {
  return {
    cloneSimple: (url: string, dest: string, options?: CloneOptions) =>
      Effect.gen(function* () {
        const effectiveUrl = options?.token ? injectTokenIntoUrl(url, options.token) : url

        if (options?.sparse) {
          // Sparse checkout: blobless clone without checkout, then sparse-checkout the subpath
          const cloneArgs = ["clone", "--filter=blob:none", "--no-checkout", "--progress"]
          if (options.ref) {
            cloneArgs.push("--branch", options.ref)
          }
          cloneArgs.push(effectiveUrl, dest)
          yield* runGit(spawner, cloneArgs, options?.repoPath ?? ".")

          yield* runGit(spawner, ["sparse-checkout", "init", "--cone"], dest)
          yield* runGit(spawner, ["sparse-checkout", "set", options.sparse], dest)
          yield* runGit(spawner, ["checkout"], dest)
        } else {
          // Standard full clone
          const args = ["clone", "--progress"]
          if (options?.ref) {
            args.push("--branch", options.ref)
          }
          args.push(effectiveUrl, dest)

          const proc = yield* spawner.spawn("git", args, {
            cwd: options?.repoPath,
            env: gitSpawnEnv(),
          })
          const chunks = yield* Stream.runCollect(proc.output)
          const code = yield* proc.exitCode

          if (code !== 0) {
            const lines = Chunk.toArray(chunks)
            const stderr = lines
              .filter((l) => l.source === "stderr")
              .map((l) => l.line)
              .join("\n")
            return yield* Effect.fail(
              new GitError({ command: `git clone`, stderr, exitCode: code }),
            )
          }
        }

        // Count files in the destination
        const lsProc = yield* spawner.spawn("find", [".", "-type", "f"], { cwd: dest })
        const lsChunks = yield* Stream.runCollect(lsProc.output)
        const fileCount = Chunk.toArray(lsChunks).filter((l) => l.source === "stdout").length
        const absolutePath = path.resolve(dest)

        return {
          fileCount,
          absolutePath,
          relativePath: dest,
        } satisfies CloneResult
      }),

    push: (repoPath: string, remote: string, branch: string, options?: PushOptions) =>
      Effect.gen(function* () {
        const args = ["push"]
        if (options?.setUpstream) {
          args.push("-u")
        }
        args.push(remote, branch)

        // If a token is provided, temporarily set the remote URL with credentials
        if (options?.token) {
          const urlLines = yield* runGit(spawner, ["remote", "get-url", remote], repoPath)
          const originalUrl = urlLines[0] ?? ""
          const authedUrl = injectTokenIntoUrl(originalUrl, options.token)
          yield* runGit(spawner, ["remote", "set-url", remote, authedUrl], repoPath)
          yield* runGit(spawner, args, repoPath).pipe(
            Effect.ensuring(
              runGit(spawner, ["remote", "set-url", remote, originalUrl], repoPath).pipe(
                Effect.catchAll(() => Effect.void),
              ),
            ),
          )
          return undefined as void
        }

        yield* runGit(spawner, args, repoPath)
      }),

    deleteBranch: (repoPath: string, branch: string) =>
      Effect.gen(function* () {
        yield* runGit(spawner, ["branch", "-d", branch], repoPath)
      }),

    getCurrentBranch: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["rev-parse", "--abbrev-ref", "HEAD"], repoPath)
        return lines[0] ?? ""
      }),

    getRepoRoot: (repoPath: string) =>
      Effect.gen(function* () {
        // `--show-toplevel` resolves the repo root from anywhere inside the
        // work tree, so a user who picks a subdirectory of their checkout
        // still ends up registering the repo itself.
        const lines = yield* runGit(spawner, ["rev-parse", "--show-toplevel"], repoPath)
        return lines[0]?.trim() ?? ""
      }),

    getRemoteUrl: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["remote", "get-url", "origin"], repoPath)
        return lines[0] ?? ""
      }),

    getInfo: (repoPath: string) =>
      Effect.gen(function* () {
        const branchLines = yield* runGit(spawner, ["rev-parse", "--abbrev-ref", "HEAD"], repoPath)
        let branch = branchLines[0] ?? ""

        // Determine ref type. A named branch is a branch even when its tip is
        // tagged. Checking out a tag always detaches HEAD (abbrev-ref prints
        // "HEAD"), so only then ask whether HEAD sits exactly on a tag, and
        // report the tag name as the ref.
        let refType: GitInfo["refType"] = "branch"
        if (branch === "HEAD") {
          const tagResult = yield* runGit(spawner, ["describe", "--tags", "--exact-match", "HEAD"], repoPath).pipe(
            Effect.catchAll(() => Effect.succeed([] as string[])),
          )
          const tag = tagResult[0]?.trim()
          if (tag) {
            branch = tag
            refType = "tag"
          } else {
            refType = "detached"
          }
        }

        // Get remote URL
        const remoteUrl = yield* runGit(spawner, ["remote", "get-url", "origin"], repoPath).pipe(
          Effect.map((lines) => lines[0]),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )

        // Get commit SHA
        const shaLines = yield* runGit(spawner, ["rev-parse", "HEAD"], repoPath).pipe(
          Effect.catchAll(() => Effect.succeed([] as string[])),
        )
        const commitSha = shaLines[0]

        return { branch, refType, remoteUrl, commitSha } satisfies GitInfo
      }),

    diff: (repoPath: string, filePath?: string) =>
      Effect.gen(function* () {
        // Diff the worktree against HEAD, the same base originalContent comes
        // from, so staged changes get real counts too (plain `git diff` is
        // worktree vs index and reports nothing for them). HEAD is resolved
        // once so the counts and every `git show` below read the same commit
        // even if a commit lands mid-poll. An unborn branch has no HEAD to
        // compare against, so fall back to worktree vs index.
        const head = yield* resolveHead(spawner, repoPath)

        // One numstat for every path. -z keeps paths verbatim; --no-renames
        // keeps one path per record, matching `status`.
        const numstatArgs = ["diff", "--numstat", "-z", "--no-renames"]
        if (head) numstatArgs.push(head)
        numstatArgs.push("--")
        if (filePath) numstatArgs.push(filePath)
        const records = nulFields(yield* runGit(spawner, numstatArgs, repoPath))

        const stats: { addStr: string; delStr: string; diffPath: string }[] = []
        for (const record of records) {
          // `<added>\t<deleted>\t<path>`; the path may itself contain tabs.
          const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record)
          if (!match) continue
          const [, addStr, delStr, diffPath] = match
          stats.push({ addStr, delStr, diffPath })
        }

        return yield* Effect.forEach(
          stats,
          ({ addStr, delStr, diffPath }) =>
            Effect.gen(function* () {
              const isBinary = addStr === "-" && delStr === "-"

              // Original (HEAD) content. The Changed Files view needs this to
              // render deleted files at all and to compute the before/after diff
              // for modified files. Files not present in HEAD (e.g. newly added)
              // make `git show` fail; treat that as "no original" rather than an
              // error so the rest of the diff still renders.
              const originalContent =
                isBinary || !head
                  ? undefined
                  : yield* runGit(spawner, ["show", `${head}:${diffPath}`], repoPath).pipe(
                      Effect.map((lines): string | undefined => lines.join("\n")),
                      Effect.catchAll(() => Effect.succeed(undefined)),
                    )

              return {
                path: diffPath,
                changeType: "modified",
                additions: isBinary ? 0 : parseInt(addStr, 10),
                deletions: isBinary ? 0 : parseInt(delStr, 10),
                originalContent,
                isBinary,
              } satisfies DiffEntry
            }),
          { concurrency: SHOW_CONCURRENCY },
        )
      }),

    status: (repoPath: string) =>
      Effect.gen(function* () {
        // -z prints paths verbatim; without it git C-quotes any path with a
        // space or non-ASCII character (`"my file.txt"`).
        const lines = yield* runGit(
          spawner,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          repoPath,
        )
        const fields = nulFields(lines)
        const entries: StatusEntry[] = []
        for (let i = 0; i < fields.length; i++) {
          const xy = fields[i].slice(0, 2)
          const entry: StatusEntry = { path: fields[i].slice(3), status: xy.trim() }
          // A rename/copy record is followed by a second field holding the
          // path it came from: new path first, then the old one.
          if (xy.includes("R") || xy.includes("C")) {
            entries.push({ ...entry, origPath: fields[++i] })
          } else {
            entries.push(entry)
          }
        }
        return entries
      }),

    hasCommits: (repoPath: string) =>
      // `--verify --quiet` exits 1 (no output) only when HEAD resolves to nothing,
      // i.e. an unborn branch. Anything else (not a repo, dubious ownership, spawn
      // failure) is a real error and propagates, so callers' best-effort fallbacks apply.
      runGit(spawner, ["rev-parse", "--verify", "--quiet", "HEAD"], repoPath).pipe(
        Effect.as(true),
        Effect.catchTag("GitError", (e) => (e.exitCode === 1 ? Effect.succeed(false) : Effect.fail(e))),
      ),

    hasChanges: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["status", "--porcelain", "--untracked-files=all"], repoPath)
        return lines.some((l) => l.trim().length > 0)
      }),

    checkIgnored: (repoPath: string, paths: string[]) =>
      Effect.gen(function* () {
        if (paths.length === 0) return new Set<string>()
        // -z: NUL-separated paths in and out. Without it git C-quotes
        // non-ASCII paths in its output, so they never match the input.
        const stdin = paths.map((p) => `${p}\0`).join("")
        // git check-ignore exits with 1 when no paths are ignored, so handle that
        const proc = yield* spawner.spawn("git", ["check-ignore", "-z", "--stdin"], {
          cwd: repoPath,
          stdin,
          env: gitSpawnEnv(),
        })
        const chunks = yield* Stream.runCollect(proc.output)
        // Ignore exit code — 1 just means "no ignored files found"
        const lines = Chunk.toArray(chunks)
          .filter((l) => l.source === "stdout")
          .map((l) => l.line)
        return new Set(nulFields(lines))
      }),

    createBranch: (repoPath: string, branch: string) =>
      Effect.gen(function* () {
        yield* runGit(spawner, ["checkout", "-b", branch], repoPath)
      }),

    stageAll: (repoPath: string, excludePaths: string[] = []) =>
      Effect.gen(function* () {
        if (excludePaths.length === 0) {
          yield* runGit(spawner, ["add", "-A"], repoPath)
          return
        }
        // The `:(exclude)` magic pathspec needs a positive pathspec ('.')
        // alongside it. Used to keep embedded git repos out of the commit so
        // they aren't staged as broken submodule gitlinks.
        const excludes = excludePaths.map(
          (p) => `:(exclude)${p.replace(/\/+$/, "")}`,
        )
        yield* runGit(spawner, ["add", "-A", "--", ".", ...excludes], repoPath)
      }),

    commit: (repoPath: string, message: string, options?: CommitOptions) =>
      Effect.gen(function* () {
        const args = ["commit", "-m", message]
        if (options?.allowEmpty) {
          args.push("--allow-empty")
        }

        // Respect the user's own git identity when one is configured. Only when
        // the repo can resolve no identity at all (fresh machine / clean CI) do
        // we fall back to the authenticated user's identity so the commit — and
        // therefore MR/PR creation — doesn't die with "author identity unknown".
        // Inject it via env (not `-c`) so the GitError command string stays
        // "git commit …" and the values never leak into error output.
        let env: Record<string, string | undefined> | undefined
        if (options?.author && !(yield* hasConfiguredIdentity(spawner, repoPath))) {
          const { name, email } = options.author
          env = {
            ...gitSpawnEnv(),
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: name,
            GIT_COMMITTER_EMAIL: email,
          }
        }

        yield* runGit(spawner, args, repoPath, undefined, env)
      }),
  }
}

export const GitCliClientLive = Layer.effect(
  GitClient,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    return makeGitClient(spawner)
  }),
)
