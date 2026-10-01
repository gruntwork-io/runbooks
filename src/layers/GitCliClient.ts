/**
 * Live implementation of the GitClient service using ProcessSpawner.
 *
 * This layer depends on ProcessSpawner, so it uses Layer.effect to pull
 * the spawner from context.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Layer, Stream, Chunk } from "effect"
import { GitClient } from "../services/GitClient.ts"
import type {
  GitClientShape,
  CloneOptions,
  PushOptions,
  DiffEntry,
  StatusEntry,
  GitInfo,
  CommitOptions,
} from "../services/GitClient.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { GitError } from "../errors/index.ts"
import { sameHttpOrigin, stripUrlCredentials, withGitHttpAuth } from "../domain/git/url.ts"
import { gitSpawnEnv, resolveSshCommand } from "../domain/git/env.ts"

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
 * Spawn environment for a git command that may start ssh (clone, push): the
 * no-prompt guards wrapped around the user's core.sshCommand as seen from
 * `cwd`. See gitSpawnEnv.
 */
function sshSpawnEnv(spawner: ProcessSpawner["Type"], cwd: string) {
  return resolveSshCommand(cwd).pipe(
    Effect.provideService(ProcessSpawner, spawner),
    Effect.map((sshCommand) => gitSpawnEnv(sshCommand)),
  )
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
 * joining on "\n" restores it before splitting on NUL. readline also ends a
 * line at a lone "\r" or at "\r\n", so a CR inside a path comes back as "\n"
 * (a limit of the line-based runGit; such paths won't match on disk).
 */
function nulFields(lines: string[]): string[] {
  return lines
    .join("\n")
    .split("\0")
    .filter((f) => f.length > 0)
}

/**
 * Resolve HEAD to a commit SHA, or undefined on an unborn branch (a repo with
 * no commits yet). `--verify --quiet` exits 1 only when HEAD resolves to
 * nothing; any other failure (not a repo, dubious ownership, spawn error)
 * propagates.
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

/**
 * Whether the checkout is a sparse checkout (`git sparse-checkout init` sets
 * core.sparseCheckout). An unset key, or a failure to read it, counts as not.
 */
function isSparseCheckout(spawner: ProcessSpawner["Type"], repoPath: string) {
  return runGit(spawner, ["config", "--bool", "--get", "core.sparseCheckout"], repoPath).pipe(
    Effect.map((lines) => lines.join("").trim() === "true"),
    Effect.catchAll(() => Effect.succeed(false)),
  )
}

/**
 * The repo-relative paths, of those given, that are on disk under `repoRoot`.
 * A directory found missing is remembered, so the many entries outside a
 * sparse checkout cost one lstat per missing directory, not one per file. A
 * path through a symlinked directory counts as missing, as it does for git.
 */
function pathsOnDisk(repoRoot: string, paths: readonly string[]): string[] {
  const dirs = new Map<string, boolean>([[".", true]])
  const isDir = (dir: string): boolean => {
    let found = dirs.get(dir)
    if (found === undefined) {
      found =
        isDir(path.posix.dirname(dir)) &&
        fs.lstatSync(path.join(repoRoot, dir), { throwIfNoEntry: false })?.isDirectory() === true
      dirs.set(dir, found)
    }
    return found
  }
  return paths.filter(
    (p) =>
      isDir(path.posix.dirname(p)) &&
      fs.lstatSync(path.join(repoRoot, p), { throwIfNoEntry: false }) !== undefined,
  )
}

/**
 * In a sparse checkout, clear the skip-worktree bit of every index entry whose
 * file is on disk, as git 2.36 and later do each time they read the index.
 * git 2.34 and 2.35 keep the bit on a file a block wrote outside the cone, and
 * `add` passes over such entries, `--sparse` or not, so the edit would be left
 * out of the commit without a word. A file that is not on disk keeps its bit,
 * so it is never staged as a deletion.
 */
function clearSkipWorktreeOfPresentFiles(spawner: ProcessSpawner["Type"], repoPath: string) {
  return Effect.gen(function* () {
    // `-t` tags skip-worktree entries "S "; `-z` ends each entry with NUL and
    // leaves paths unquoted. The spawner splits output at line breaks, so the
    // lines are joined back with "\n". (A path with a carriage return comes
    // back altered, is not found on disk, and keeps its bit.)
    const listed = (yield* runGit(spawner, ["ls-files", "-t", "-z"], repoPath)).join("\n")
    const skipped = listed
      .split("\0")
      .filter((entry) => entry.startsWith("S "))
      .map((entry) => entry.slice(2))
    if (skipped.length === 0) return
    const present = yield* Effect.sync(() => pathsOnDisk(repoPath, skipped))
    if (present.length === 0) return
    yield* runGit(
      spawner,
      ["update-index", "--no-skip-worktree", "-z", "--stdin"],
      repoPath,
      present.map((p) => `${p}\0`).join(""),
    )
  })
}

/** A full or abbreviated commit id (SHA-1 or SHA-256). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i

function makeGitClient(spawner: ProcessSpawner["Type"]): GitClientShape {
  return {
    cloneSimple: (url: string, dest: string, options?: CloneOptions) =>
      Effect.gen(function* () {
        // The token rides in the environment, never in the URL, so the clone's
        // origin (and its .git/config) stays credential-free. Every command
        // below gets the same auth: a blobless clone fetches file contents
        // lazily from origin during checkout, and a commit may be fetched.
        // No repo exists yet, so the user's core.sshCommand is looked up from
        // dest's parent; the follow-up commands reuse the env for the same
        // reason they reuse the auth.
        const sshEnv = yield* sshSpawnEnv(
          spawner,
          path.dirname(path.resolve(options?.repoPath ?? "", dest)),
        )
        const env = withGitHttpAuth(sshEnv, url, options?.token, options?.username)
        const ref = options?.ref
        // `git clone --branch` takes only a branch or tag name, so a commit
        // is checked out once the clone is down.
        const commit = ref !== undefined && COMMIT_SHA.test(ref) ? ref : undefined
        const sparse = options?.sparse

        const cloneArgs = ["clone", "--progress"]
        // Blobless: commits and trees arrive up front (enough to inspect the
        // sparse path below), file contents only for what is checked out.
        if (sparse) cloneArgs.push("--filter=blob:none")
        if (sparse || commit) cloneArgs.push("--no-checkout")
        if (ref && !commit) cloneArgs.push("--branch", ref)
        // `--` so a URL starting with `-` can never read as an option.
        cloneArgs.push("--", url, dest)
        yield* runGit(spawner, cloneArgs, options?.repoPath ?? ".", undefined, env)

        let rev = "HEAD"
        if (commit) {
          const fetched = yield* runGit(
            spawner,
            ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
            dest,
            undefined,
            env,
          ).pipe(
            Effect.as(true),
            Effect.catchTag("GitError", () => Effect.succeed(false)),
          )
          if (fetched) {
            rev = commit
          } else {
            // Not reachable from anything the clone fetched (e.g. a pull
            // request head): ask for it by id.
            yield* runGit(spawner, ["fetch", "origin", commit], dest, undefined, env)
            rev = "FETCH_HEAD"
          }
        }

        if (sparse) {
          // The sparse path may name a file. A runbook file needs its whole
          // directory (templates and assets sit beside it), so a file checks
          // out its parent. A path that doesn't exist checks out nothing and
          // is the caller's to report.
          const entry = yield* runGit(spawner, ["ls-tree", rev, "--", sparse], dest, undefined, env)
          const isFile = /^\d+ blob /.test(entry[0] ?? "")
          const dir = isFile ? path.posix.dirname(sparse) : sparse
          if (dir !== ".") {
            yield* runGit(spawner, ["sparse-checkout", "init", "--cone"], dest, undefined, env)
            yield* runGit(spawner, ["sparse-checkout", "set", "--", dir], dest, undefined, env)
          }
        }

        if (commit) {
          yield* runGit(spawner, ["checkout", "--detach", rev], dest, undefined, env)
        } else if (sparse) {
          yield* runGit(spawner, ["checkout"], dest, undefined, env)
        }
      }),

    push: (repoPath: string, remote: string, branch: string, options?: PushOptions) =>
      Effect.gen(function* () {
        const args = ["push"]
        if (options?.setUpstream) {
          args.push("-u")
        }
        // `--` keeps a branch that looks like an option (e.g.
        // `--receive-pack=<command>`, which git would run) a refspec.
        args.push("--", remote, branch)
        const env = yield* sshSpawnEnv(spawner, repoPath)

        // Authenticate this one push through the environment rather than by
        // rewriting the remote URL, so the token never lands in .git/config and
        // an SSH remote keeps its own user and port. `--push` reads the URL the
        // push will actually use (pushurl / pushInsteadOf applied). Callers
        // bind the token to the fetch URL's host (e.g. resolveGitHubTokenForRepo
        // reads getRemoteUrl), so a push URL on another origin gets no token:
        // that push authenticates the way git would on its own.
        if (options?.token) {
          const [pushUrl = ""] = yield* runGit(
            spawner,
            ["remote", "get-url", "--push", remote],
            repoPath,
          )
          const [fetchUrl = ""] = yield* runGit(spawner, ["remote", "get-url", remote], repoPath)
          if (sameHttpOrigin(pushUrl, fetchUrl)) {
            const authEnv = withGitHttpAuth(env, pushUrl, options.token, options.username)
            yield* runGit(spawner, args, repoPath, undefined, authEnv)
            return
          }
        }

        yield* runGit(spawner, args, repoPath, undefined, env)
      }),

    deleteBranch: (repoPath: string, branch: string) =>
      Effect.gen(function* () {
        yield* runGit(spawner, ["branch", "-d", "--", branch], repoPath)
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
        return stripUrlCredentials(lines[0] ?? "")
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
          const tagResult = yield* runGit(
            spawner,
            ["describe", "--tags", "--exact-match", "HEAD"],
            repoPath,
          ).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))
          const tag = tagResult[0]?.trim()
          if (tag) {
            branch = tag
            refType = "tag"
          } else {
            refType = "detached"
          }
        }

        // Get remote URL, minus any token a checkout carries in it: this is
        // returned to the renderer (git:local-repo, workspace:tree).
        const remoteUrl = yield* runGit(spawner, ["remote", "get-url", "origin"], repoPath).pipe(
          Effect.map((lines) => lines[0] && stripUrlCredentials(lines[0])),
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

        // One diff for every path. -z keeps paths verbatim; --no-renames keeps
        // one path per record, matching `status`. --raw adds each path's
        // status letter, so paths added relative to HEAD skip the `git show`
        // below instead of spawning one that is certain to fail.
        const diffArgs = ["diff", "--raw", "--numstat", "-z", "--no-renames"]
        if (head) diffArgs.push(head)
        diffArgs.push("--")
        if (filePath) diffArgs.push(filePath)
        const fields = nulFields(yield* runGit(spawner, diffArgs, repoPath))

        const addedPaths = new Set<string>()
        const stats: { addStr: string; delStr: string; diffPath: string }[] = []
        for (let i = 0; i < fields.length; i++) {
          // Raw records come first, as two fields:
          // `:<omode> <nmode> <osha> <nsha> <X>` then `<path>`. A numstat
          // record never starts with ':', so the two can't be confused.
          const raw = /^:[0-7]+ [0-7]+ \S+ \S+ ([A-Z])\d*$/.exec(fields[i])
          if (raw) {
            const rawPath = fields[++i]
            if (raw[1] === "A" && rawPath !== undefined) addedPaths.add(rawPath)
            continue
          }
          // Then numstat records: `<added>\t<deleted>\t<path>`; the path may
          // itself contain tabs.
          const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(fields[i])
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
              // for modified files. A path added relative to HEAD (a staged new
              // file, the new side of a staged rename) has none, so it isn't
              // read. Should `git show` still fail, treat that as "no original"
              // rather than an error so the rest of the diff still renders.
              const originalContent =
                isBinary || !head || addedPaths.has(diffPath)
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
      // Errors propagate (see resolveHead), so callers' best-effort fallbacks apply.
      resolveHead(spawner, repoPath).pipe(Effect.map((sha) => sha !== undefined)),

    hasCommitsNotIn: (repoPath: string, ref: string) =>
      runGit(spawner, ["rev-list", "--count", `${ref}..HEAD`, "--"], repoPath).pipe(
        Effect.map((lines) => Number(lines[0]) > 0),
      ),

    hasCommitsNotOnRemote: (repoPath: string, remote: string) =>
      runGit(
        spawner,
        ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`, "--"],
        repoPath,
      ).pipe(Effect.map((lines) => Number(lines[0]) > 0)),

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
        // In a sparse checkout (a GitClone with a repo path), plain `add -A`
        // leaves out what a block wrote outside the sparse-checkout cone: it
        // skips edits to tracked files there without a word and fails on new
        // files. `--sparse` stages them like any other change, once no file
        // on disk is still flagged skip-worktree (which git 2.34 and 2.35
        // leave to us).
        const sparse = yield* isSparseCheckout(spawner, repoPath)
        if (sparse) yield* clearSkipWorktreeOfPresentFiles(spawner, repoPath)
        const add = sparse ? ["add", "-A", "--sparse"] : ["add", "-A"]
        // The `:(exclude)` magic pathspec needs a positive pathspec ('.')
        // alongside it. Used to keep embedded git repos out of the commit so
        // they aren't staged as broken submodule gitlinks.
        const excludes = excludePaths.map((p) => `:(exclude)${p.replace(/\/+$/, "")}`)
        const args = excludes.length === 0 ? add : [...add, "--", ".", ...excludes]
        yield* runGit(spawner, args, repoPath).pipe(
          // git before 2.34 has no `--sparse`. How a git that old stages a
          // sparse checkout without it is not tested here, so say what is
          // needed rather than risk committing only part of what the blocks
          // wrote.
          Effect.mapError((e) =>
            sparse && e._tag === "GitError" && /unknown option [`']sparse'/.test(e.stderr)
              ? new GitError({
                  command: e.command,
                  stderr:
                    "This checkout is a sparse checkout (cloned with a repo path), and staging the files " +
                    "written outside it needs `git add --sparse`, from git 2.34 or later. Upgrade git, " +
                    "or clone the repository without a repo path.",
                  exitCode: e.exitCode,
                })
              : e,
          ),
        )
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
