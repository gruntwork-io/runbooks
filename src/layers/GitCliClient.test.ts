/**
 * Integration tests for the live GitClient implementation, run against a real
 * temporary git repository (not a stub).
 *
 * These are the regression guard for the `git.diff()` originalContent bug: the
 * workspace unit tests stub `git.diff` to *return* `originalContent`, so they
 * pass even when the real implementation never populates it. Only a test that
 * drives the actual `GitCliClientLive` layer against real git catches that.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { GitClient } from "../services/GitClient.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import type { SpawnOptions } from "../services/ProcessSpawner.ts"
import { GitError } from "../errors/index.ts"
import { GitCliClientLive } from "./GitCliClient.ts"
import { ChildProcessSpawnerLive } from "./ChildProcessSpawner.ts"

const layer = GitCliClientLive.pipe(Layer.provide(ChildProcessSpawnerLive))

const runDiff = (repoPath: string, filePath?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitClient
      return yield* git.diff(repoPath, filePath)
    }).pipe(Effect.provide(layer)),
  )

const runStageAll = (repoPath: string, excludePaths: string[] = []) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitClient
      return yield* git.stageAll(repoPath, excludePaths)
    }).pipe(Effect.provide(layer)),
  )

const runCommitEither = (
  repoPath: string,
  message: string,
  options?: { allowEmpty?: boolean; author?: { name: string; email: string } },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitClient
      return yield* git.commit(repoPath, message, options)
    }).pipe(Effect.provide(layer), Effect.either),
  )

/** Stand-in for the authenticated GitLab/GitHub user threaded into commits. */
const TEST_AUTHOR = { name: "Authed User", email: "authed@example.com" }

/** git config args shared by the deterministic helpers below. */
const GIT_CONFIG = [
  "-c", "user.email=test@example.com",
  "-c", "user.name=Test",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
]

/** Run git in the repo with deterministic, environment-independent config. */
function git(repoPath: string, ...args: string[]): void {
  execFileSync("git", [...GIT_CONFIG, ...args], { cwd: repoPath, stdio: "pipe" })
}

/** Like `git`, but returns stdout (for inspecting the index, etc.). */
function gitOut(repoPath: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_CONFIG, ...args], {
    cwd: repoPath,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString()
}

/** Restore (or delete) a process.env var captured before a test mutated it. */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = saved
  }
}

describe("GitCliClientLive.diff (real repo)", () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitdiff-"))
    git(repoPath, "init")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "line one\nline two\n")
    git(repoPath, "add", "tracked.txt")
    git(repoPath, "commit", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true })
  })

  it("populates originalContent from HEAD for a modified file", async () => {
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "line one\nCHANGED\n")

    const entries = await runDiff(repoPath)
    const entry = entries.find((e) => e.path === "tracked.txt")

    expect(entry).toBeDefined()
    // The committed (HEAD) version, not the working-tree version.
    expect(entry?.originalContent).toBe("line one\nline two")
    expect(entry?.additions).toBeGreaterThan(0)
    expect(entry?.deletions).toBeGreaterThan(0)
  })

  it("populates originalContent from HEAD for a deleted file", async () => {
    fs.rmSync(path.join(repoPath, "tracked.txt"))

    const entries = await runDiff(repoPath)
    const entry = entries.find((e) => e.path === "tracked.txt")

    expect(entry).toBeDefined()
    expect(entry?.originalContent).toBe("line one\nline two")
  })

  it("leaves originalContent undefined for a file not in HEAD", async () => {
    // Stage a brand-new file, then modify it in the working tree. The
    // worktree-vs-index diff surfaces it, but there is no HEAD version to read,
    // so originalContent must stay undefined rather than error out.
    fs.writeFileSync(path.join(repoPath, "fresh.txt"), "brand new\n")
    git(repoPath, "add", "fresh.txt")
    fs.writeFileSync(path.join(repoPath, "fresh.txt"), "brand new\nmore\n")

    const entries = await runDiff(repoPath, "fresh.txt")
    const entry = entries.find((e) => e.path === "fresh.txt")

    expect(entry).toBeDefined()
    expect(entry?.originalContent).toBeUndefined()
  })
})

describe("GitCliClientLive.stageAll (real repo)", () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitstage-"))
    git(repoPath, "init")
    // A plain untracked file that SHOULD be staged.
    fs.writeFileSync(path.join(repoPath, "normal.txt"), "hello\n")
    // An embedded git repository (nested .git) — git reports it as `sub/` and
    // `git add -A` would otherwise stage it as a submodule gitlink (mode 160000).
    const sub = path.join(repoPath, "sub")
    fs.mkdirSync(sub)
    git(sub, "init")
    fs.writeFileSync(path.join(sub, "inner.txt"), "inner\n")
    git(sub, "add", "inner.txt")
    git(sub, "commit", "-m", "sub initial")
  })

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true })
  })

  it("excludes an embedded repo from the index while staging the rest", async () => {
    await runStageAll(repoPath, ["sub"])

    const staged = gitOut(repoPath, "ls-files", "--stage")
    expect(staged).toContain("normal.txt")
    // No gitlink (mode 160000) for the embedded repo.
    expect(staged).not.toContain("160000")
    expect(staged).not.toContain("sub")
  })

  it("without excludes, stages the embedded repo as a gitlink (control)", async () => {
    await runStageAll(repoPath, [])

    const staged = gitOut(repoPath, "ls-files", "--stage")
    expect(staged).toContain("normal.txt")
    // The embedded repo lands as a mode-160000 submodule pointer — the broken
    // behavior the excludePaths argument exists to prevent.
    expect(staged).toContain("160000")
    expect(staged).toContain("sub")
  })
})

describe("GitCliClientLive option-like branch names (real repo)", () => {
  // git reads options anywhere on its command line, so a branch name that
  // begins with `-` must reach git after `--`, never as an option.
  let root: string
  let work: string
  let marker: string
  let savedConfigGlobal: string | undefined
  let savedConfigSystem: string | undefined

  const run = <A, E>(program: (git: GitClient["Type"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* program(yield* GitClient)
      }).pipe(Effect.provide(layer), Effect.either),
    )

  beforeEach(() => {
    // Only the defaults apply (push.default=simple), whatever the machine has.
    savedConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    savedConfigSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"

    root = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitopts-"))
    marker = path.join(root, "pwned")
    const origin = path.join(root, "origin.git")
    git(root, "init", "--bare", origin)
    work = path.join(root, "work")
    git(root, "clone", origin, work)
    git(work, "commit", "--allow-empty", "-m", "initial")
    // main now tracks origin/main, so a bare `git push -u origin` pushes it.
    git(work, "push", "-u", "origin", "main")
    git(work, "commit", "--allow-empty", "-m", "second")
  })

  afterEach(() => {
    restoreEnv("GIT_CONFIG_GLOBAL", savedConfigGlobal)
    restoreEnv("GIT_CONFIG_SYSTEM", savedConfigSystem)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("push takes an option-like branch as a refspec and never runs it", async () => {
    const branch = `--receive-pack=touch ${marker}; git-receive-pack`

    const result = await run((g) => g.push(work, "origin", branch, { setUpstream: true }))

    if (result._tag !== "Left" || !(result.left instanceof GitError)) {
      throw new Error("expected the push to fail with a GitError")
    }
    expect(result.left.stderr).toContain("invalid refspec")
    expect(fs.existsSync(marker)).toBe(false)
    // Nothing reached origin: its main is still the first commit.
    expect(gitOut(work, "rev-parse", "origin/main")).toBe(gitOut(work, "rev-parse", "HEAD~1"))
  })

  it("deleteBranch deletes the branch it is given, even one named like an option", async () => {
    git(work, "update-ref", "refs/heads/-D", "HEAD")

    const result = await run((g) => g.deleteBranch(work, "-D"))

    expect(result._tag).toBe("Right")
    expect(gitOut(work, "for-each-ref", "refs/heads/-D")).toBe("")
  })
})

describe("GitCliClientLive.commit (real repo)", () => {
  let repoPath: string
  let savedConfigGlobal: string | undefined
  let savedConfigSystem: string | undefined

  beforeEach(() => {
    // Make git ignore any *ambient* (global/system) identity so these tests
    // exercise the layer's own identity handling deterministically — the repo
    // starts with NO resolvable identity on every machine, dev laptop or clean
    // CI runner. (GitCliClientLive runs git via gitSpawnEnv(), which spreads
    // process.env, so these reach the real commit too.)
    savedConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    savedConfigSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"

    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitcommit-"))
    // The git() helper supplies identity per-invocation via -c, so the setup
    // commit succeeds without persisting any identity into the repo.
    git(repoPath, "init")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\n")
    git(repoPath, "add", "tracked.txt")
    git(repoPath, "commit", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true })
    restoreEnv("GIT_CONFIG_GLOBAL", savedConfigGlobal)
    restoreEnv("GIT_CONFIG_SYSTEM", savedConfigSystem)
  })

  it("surfaces git's stdout reason when there is nothing to commit (exit 1)", async () => {
    // `git commit` with a clean tree exits 1 and prints "nothing to commit,
    // working tree clean" to STDOUT (not stderr). The error must carry that
    // reason instead of a bare "exit 1" — this is exactly the MR-block failure.
    // A fallback author is supplied so the failure is the clean-tree one, not
    // "author identity unknown".
    const result = await runCommitEither(repoPath, "[skip ci] no-op commit", {
      author: TEST_AUTHOR,
    })

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      const gitErr = result.left as GitError
      expect(gitErr.exitCode).not.toBe(0)
      expect(gitErr.stderr.toLowerCase()).toContain("nothing to commit")
      // command carries the "git " prefix exactly once, and the injected
      // identity is passed via env — never leaked into the command string.
      expect(gitErr.command.startsWith("git commit")).toBe(true)
      expect(gitErr.command).not.toContain("authed@example.com")
    }
  })

  it("commits as the fallback author when the repo has no configured identity", async () => {
    // The MR/PR failure mode: a machine with no git identity. The layer must
    // commit as the authenticated user instead of dying with "author identity
    // unknown".
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\ntwo\n")
    await runStageAll(repoPath, [])

    const result = await runCommitEither(repoPath, "add line two", {
      author: TEST_AUTHOR,
    })

    expect(result._tag).toBe("Right")
    expect(gitOut(repoPath, "log", "--oneline")).toContain("add line two")
    expect(gitOut(repoPath, "log", "-1", "--format=%an <%ae>").trim()).toBe(
      "Authed User <authed@example.com>",
    )
  })

  it("respects the repo's configured identity over the fallback author", async () => {
    // When the user HAS a git identity, theirs wins — the fallback is ignored.
    git(repoPath, "config", "user.name", "Local Dev")
    git(repoPath, "config", "user.email", "local@example.com")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\ntwo\n")
    await runStageAll(repoPath, [])

    const result = await runCommitEither(repoPath, "respect local identity", {
      author: TEST_AUTHOR,
    })

    expect(result._tag).toBe("Right")
    expect(gitOut(repoPath, "log", "-1", "--format=%an <%ae>").trim()).toBe(
      "Local Dev <local@example.com>",
    )
  })

  it("fails with 'author identity unknown' when no identity and no fallback author", async () => {
    // Regression guard: without the fallback author, an unconfigured machine
    // can't commit — exactly the bug the author option fixes. useConfigOnly
    // disables git's gecos-based auto-detection so the failure is deterministic
    // on dev machines too (CI runners have an empty gecos and fail anyway).
    git(repoPath, "config", "user.useConfigOnly", "true")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\ntwo\n")
    await runStageAll(repoPath, [])

    const result = await runCommitEither(repoPath, "no identity available")

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect((result.left as GitError).stderr.toLowerCase()).toContain("author identity unknown")
    }
  })
})

describe("GitCliClientLive.cloneSimple (real git)", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitclone-"))
    fs.mkdirSync(path.join(tmp, "src"))
    fs.mkdirSync(path.join(tmp, "work"))
    git(path.join(tmp, "src"), "init")
    git(path.join(tmp, "src"), "commit", "--allow-empty", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it.each([
    ["full", {}],
    ["sparse", { sparse: "sub" }],
  ])("never lets a %s clone's URL act as a git option", async (_kind, extra) => {
    // Were the URL parsed as an option, git would take `dest` as the
    // repository and run this upload-pack command against it.
    const marker = path.join(tmp, "upload-pack-ran")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient
        return yield* git.cloneSimple(
          `--upload-pack=touch ${marker};`,
          `file://${path.join(tmp, "src")}`,
          { repoPath: path.join(tmp, "work"), ...extra },
        )
      }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe("GitCliClientLive ssh command (real git)", () => {
  // Push and clone must run the ssh the user's git would (core.sshCommand),
  // wrapped in the no-prompt flags, rather than replacing it with plain ssh.
  const ENV_KEYS = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]
  const BATCH_OPTIONS = "-o BatchMode=yes -o StrictHostKeyChecking=yes"
  const saved = new Map<string, string | undefined>()
  let tmp: string
  let sshLog: string
  let fakeSsh: string

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitssh-"))
    // Only the config each test writes decides which ssh git runs. Write this
    // file directly, never with `git config --global` through the git()
    // helper: its execFileSync doesn't see process.env changes under bun, so
    // that would edit the developer's real ~/.gitconfig.
    process.env.GIT_CONFIG_GLOBAL = path.join(tmp, "gitconfig")
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    // A stand-in ssh that records its arguments and fails like an unreachable
    // host. Named `ssh` so git treats it as OpenSSH.
    sshLog = path.join(tmp, "ssh-args.log")
    fakeSsh = path.join(tmp, "ssh")
    fs.writeFileSync(fakeSsh, `#!/bin/sh\necho "$*" >> '${sshLog}'\nexit 255\n`, { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    for (const key of ENV_KEYS) restoreEnv(key, saved.get(key))
  })

  it("pushes with the repo's own core.sshCommand, in batch mode", async () => {
    // The multi-account setup: a per-repo key set inside the checkout.
    const repoPath = path.join(tmp, "repo")
    fs.mkdirSync(repoPath)
    git(repoPath, "init")
    git(repoPath, "commit", "--allow-empty", "-m", "initial")
    git(repoPath, "remote", "add", "origin", "git@example.invalid:o/r.git")
    git(repoPath, "config", "core.sshCommand", `'${fakeSsh}' -i /keys/id_work`)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient
        return yield* git.push(repoPath, "origin", "main")
      }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    const args = fs.readFileSync(sshLog, "utf8")
    expect(args).toContain(`-i /keys/id_work ${BATCH_OPTIONS}`)
    expect(args).toContain("git-receive-pack")
  })

  it.each([
    ["full", {}],
    ["sparse", { sparse: "sub" }],
  ])("clones a %s checkout with the global core.sshCommand, in batch mode", async (_kind, extra) => {
    // No repo exists before a clone, so the user's global config applies.
    fs.writeFileSync(
      process.env.GIT_CONFIG_GLOBAL!,
      `[core]\n\tsshCommand = '${fakeSsh}' -i /keys/id_work\n`,
    )
    const work = path.join(tmp, "work")
    fs.mkdirSync(work)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient
        return yield* git.cloneSimple("git@example.invalid:o/r.git", path.join(work, "r"), {
          repoPath: work,
          ...extra,
        })
      }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    const args = fs.readFileSync(sshLog, "utf8")
    expect(args).toContain(`-i /keys/id_work ${BATCH_OPTIONS}`)
    expect(args).toContain("git-upload-pack")
  })
})

// ---------------------------------------------------------------------------
// cloneSimple — the remote-runbook clone: sparse paths that may name a file,
// and refs that may be a commit rather than a branch or tag.
// ---------------------------------------------------------------------------

describe("GitCliClientLive.cloneSimple (real repo)", () => {
  let srcPath: string
  let workPath: string
  let firstCommit: string

  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(srcPath, rel)), { recursive: true })
    fs.writeFileSync(path.join(srcPath, rel), content)
  }
  const exists = (dest: string, rel: string) => fs.existsSync(path.join(dest, rel))
  const read = (dest: string, rel: string) => fs.readFileSync(path.join(dest, rel), "utf8")

  const runClone = (options: { ref?: string; sparse?: string }) => {
    const dest = path.join(workPath, `clone-${Math.random().toString(36).slice(2)}`)
    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitClient
        yield* client.cloneSimple(`file://${srcPath}`, dest, options)
        return dest
      }).pipe(Effect.provide(layer)),
    )
  }

  beforeEach(() => {
    srcPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-src-"))
    workPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-dest-"))
    git(srcPath, "init")
    // Let the test fetch a commit no branch points at, as GitHub allows.
    git(srcPath, "config", "uploadpack.allowAnySHA1InWant", "true")
    write("README.md", "readme\n")
    write("runbooks/vpc/runbook.mdx", "# VPC v1\n")
    write("runbooks/vpc/templates/main.tf", "# tf\n")
    write("runbooks/other/runbook.mdx", "# Other\n")
    git(srcPath, "add", ".")
    git(srcPath, "commit", "-m", "v1")
    firstCommit = gitOut(srcPath, "rev-parse", "HEAD").trim()
    git(srcPath, "branch", "release/v1")
    write("runbooks/vpc/runbook.mdx", "# VPC v2\n")
    git(srcPath, "commit", "-am", "v2")
  })

  afterEach(() => {
    fs.rmSync(srcPath, { recursive: true, force: true })
    fs.rmSync(workPath, { recursive: true, force: true })
  })

  it("a directory path checks out that directory and everything under it", async () => {
    const dest = await runClone({ sparse: "runbooks/vpc" })
    expect(read(dest, "runbooks/vpc/runbook.mdx")).toBe("# VPC v2\n")
    expect(exists(dest, "runbooks/vpc/templates/main.tf")).toBe(true)
    expect(exists(dest, "runbooks/other/runbook.mdx")).toBe(false)
  })

  it("a file path checks out the file's whole directory", async () => {
    const dest = await runClone({ sparse: "runbooks/vpc/runbook.mdx" })
    expect(exists(dest, "runbooks/vpc/runbook.mdx")).toBe(true)
    // A sibling subdirectory — what cone mode alone would leave out.
    expect(exists(dest, "runbooks/vpc/templates/main.tf")).toBe(true)
    expect(exists(dest, "runbooks/other/runbook.mdx")).toBe(false)
  })

  it("a file at the repo root checks out the whole repo", async () => {
    const dest = await runClone({ sparse: "README.md" })
    expect(exists(dest, "runbooks/other/runbook.mdx")).toBe(true)
  })

  it("a path that doesn't exist checks out nothing, without failing", async () => {
    const dest = await runClone({ sparse: "runbooks/missing" })
    expect(exists(dest, "runbooks/missing")).toBe(false)
  })

  it("a branch whose name contains a slash", async () => {
    const dest = await runClone({ ref: "release/v1", sparse: "runbooks/vpc" })
    expect(read(dest, "runbooks/vpc/runbook.mdx")).toBe("# VPC v1\n")
  })

  it("a commit SHA, full or abbreviated, with and without a sparse path", async () => {
    expect(read(await runClone({ ref: firstCommit, sparse: "runbooks/vpc" }), "runbooks/vpc/runbook.mdx")).toBe("# VPC v1\n")
    expect(read(await runClone({ ref: firstCommit.slice(0, 7), sparse: "runbooks/vpc/runbook.mdx" }), "runbooks/vpc/runbook.mdx")).toBe(
      "# VPC v1\n",
    )
    expect(read(await runClone({ ref: firstCommit }), "runbooks/vpc/runbook.mdx")).toBe("# VPC v1\n")
  })

  it("a commit no branch or tag reaches is fetched by id", async () => {
    git(srcPath, "checkout", "--detach")
    write("runbooks/vpc/runbook.mdx", "# VPC detached\n")
    git(srcPath, "commit", "-am", "detached")
    const detached = gitOut(srcPath, "rev-parse", "HEAD").trim()
    git(srcPath, "checkout", "main")

    const dest = await runClone({ ref: detached, sparse: "runbooks/vpc" })
    expect(read(dest, "runbooks/vpc/runbook.mdx")).toBe("# VPC detached\n")
  })

  it("a URL starting with - is the repository, never an option", async () => {
    // Read as an option, `-u@host:repo` would be clone's --upload-pack and
    // the destination would become the repository to clone.
    const dest = path.join(workPath, "dash")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitClient
        return yield* client.cloneSimple("-u@host:repo", dest)
      }).pipe(Effect.provide(layer), Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      const stderr = (result.left as GitError).stderr
      expect(stderr).toContain("-u@host")
      expect(stderr).not.toContain(`repository '${dest}' does not exist`)
    }
  })
})

/**
 * A private git host on localhost: `git http-backend` (git's own smart-HTTP
 * CGI) behind a server that demands one exact basic-auth header, and records
 * every Authorization header it receives.
 */
function startGitHttpServer(projectRoot: string, expectedAuthorization: string) {
  const seenAuthorization: Array<string | undefined> = []
  const server = http.createServer((req, res) => {
    seenAuthorization.push(req.headers.authorization)
    if (req.headers.authorization !== expectedAuthorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' }).end()
      return
    }
    const body: Buffer[] = []
    req.on("data", (chunk: Buffer) => body.push(chunk))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost")
      const input = Buffer.concat(body)
      const cgi = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_PROTOCOL: req.headers["git-protocol"] as string | undefined,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(input.length),
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
          // receive-pack (push) is only served to an authenticated user.
          REMOTE_USER: "tester",
          REMOTE_ADDR: "127.0.0.1",
        },
      })
      const out: Buffer[] = []
      cgi.stdout.on("data", (chunk: Buffer) => out.push(chunk))
      cgi.on("close", () => {
        // CGI response: headers, a blank line, then the body.
        const raw = Buffer.concat(out)
        const split = raw.indexOf("\r\n\r\n")
        let status = 200
        const headers: Record<string, string> = {}
        for (const line of raw.subarray(0, split).toString().split("\r\n")) {
          const colon = line.indexOf(":")
          const name = line.slice(0, colon).trim()
          const value = line.slice(colon + 1).trim()
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10)
          else if (name) headers[name] = value
        }
        res.writeHead(status, headers).end(raw.subarray(split + 4))
      })
      cgi.stdin.end(input)
    })
  })
  return {
    seenAuthorization,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Every `git` spawn the layer makes, captured before it runs. */
interface GitSpawn {
  readonly args: string[]
  readonly env?: Record<string, string | undefined>
}

/** GitCliClientLive over the real spawner, recording each git invocation. */
const recordingLayer = (spawns: GitSpawn[]) =>
  GitCliClientLive.pipe(
    Layer.provide(
      Layer.effect(
        ProcessSpawner,
        Effect.map(ProcessSpawner, (live) => ({
          spawn: (command: string, args: string[], options?: SpawnOptions) => {
            if (command === "git") spawns.push({ args, env: options?.env })
            return live.spawn(command, args, options)
          },
        })),
      ).pipe(Layer.provide(ChildProcessSpawnerLive)),
    ),
  )

describe("GitCliClientLive token auth (real git over HTTP)", () => {
  const TOKEN = "glpat-SECRET-TOKEN-0123456789"
  const basic = (user: string, token: string) => `Basic ${btoa(`${user}:${token}`)}`

  let root: string
  let helperLog: string
  let server: ReturnType<typeof startGitHttpServer>
  let repoUrl: string
  let savedConfigGlobal: string | undefined
  let savedConfigSystem: string | undefined
  let spawns: GitSpawn[]

  const run = <A, E>(program: Effect.Effect<A, E, GitClient>) =>
    Effect.runPromise(program.pipe(Effect.provide(recordingLayer(spawns)), Effect.either))

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-githttp-"))

    // The remote: a bare repo that allows partial clones and pushes over HTTP.
    const bare = path.join(root, "server", "repo.git")
    fs.mkdirSync(bare, { recursive: true })
    git(bare, "init", "--bare")
    git(bare, "config", "uploadpack.allowFilter", "true")
    git(bare, "config", "http.receivepack", "true")
    const seed = path.join(root, "seed")
    fs.mkdirSync(path.join(seed, "docs"), { recursive: true })
    git(seed, "init")
    fs.writeFileSync(path.join(seed, "docs", "guide.md"), "# guide\n")
    fs.writeFileSync(path.join(seed, "README.md"), "readme\n")
    git(seed, "add", ".")
    git(seed, "commit", "-m", "initial")
    git(seed, "push", bare, "main")

    // Stand-in for the user's own git config: a credential helper that logs
    // every call. It must never be consulted (or told to erase anything) when
    // the layer authenticates with a token.
    helperLog = path.join(root, "helper.log")
    const globalConfig = path.join(root, "gitconfig")
    fs.writeFileSync(
      globalConfig,
      `[credential]\n\thelper = "!f() { echo \\"$1\\" >> '${helperLog}'; echo username=someone; echo password=saved; }; f"\n`,
    )
    savedConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    savedConfigSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"

    server = startGitHttpServer(path.join(root, "server"), basic("oauth2", TOKEN))
    repoUrl = `${await server.listen()}/repo.git`
  })

  afterAll(async () => {
    await server.close()
    restoreEnv("GIT_CONFIG_GLOBAL", savedConfigGlobal)
    restoreEnv("GIT_CONFIG_SYSTEM", savedConfigSystem)
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    spawns = []
    server.seenAuthorization.length = 0
    fs.rmSync(helperLog, { force: true })
  })

  const tokenInAnyArg = () => spawns.some((s) => s.args.some((a) => a.includes(TOKEN)))

  it("clones with the token without writing it into the checkout's origin URL", async () => {
    const dest = path.join(root, "clone-full")

    const result = await run(
      Effect.flatMap(GitClient, (g) => g.cloneSimple(repoUrl, dest, { token: TOKEN, username: "oauth2" })),
    )

    expect(result._tag).toBe("Right")
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("readme\n")
    expect(server.seenAuthorization).toContain(basic("oauth2", TOKEN))
    // git saves the clone URL as remote.origin.url: it must be the plain one.
    expect(gitOut(dest, "remote", "get-url", "origin").trim()).toBe(repoUrl)
    expect(fs.readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(TOKEN)
    expect(tokenInAnyArg()).toBe(false)
  }, 30_000)

  it("authenticates a sparse clone's lazy blob fetch during checkout, too", async () => {
    // A blobless clone downloads file contents from origin at checkout time,
    // so the post-clone commands need the token just as much as the clone.
    const dest = path.join(root, "clone-sparse")

    const result = await run(
      Effect.flatMap(GitClient, (g) =>
        g.cloneSimple(repoUrl, dest, { token: TOKEN, username: "oauth2", sparse: "docs" }),
      ),
    )

    expect(result._tag).toBe("Right")
    expect(fs.readFileSync(path.join(dest, "docs", "guide.md"), "utf8")).toBe("# guide\n")
    expect(fs.readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(TOKEN)
    expect(tokenInAnyArg()).toBe(false)
  }, 30_000)

  it("authenticates a commit fetched by id and a sparse file path", async () => {
    // A commit no branch or tag reaches (a pull request head) is fetched by
    // id after the clone (lazily by a blobless clone, explicitly by a full
    // one), and a file path is looked up with ls-tree: every step talks to
    // origin, so every step needs the token.
    const work = path.join(root, "pr-work")
    execFileSync("git", ["clone", "-q", path.join(root, "server", "repo.git"), work])
    fs.writeFileSync(path.join(work, "docs", "guide.md"), "# guide (pr)\n")
    git(work, "commit", "-am", "pr")
    git(work, "push", "origin", "HEAD:refs/pull/1/head")
    const prCommit = gitOut(work, "rev-parse", "HEAD").trim()
    git(path.join(root, "server", "repo.git"), "config", "uploadpack.allowAnySHA1InWant", "true")

    for (const sparse of ["docs/guide.md", undefined]) {
      const dest = path.join(root, `clone-pr-${sparse ? "sparse" : "full"}`)
      const result = await run(
        Effect.flatMap(GitClient, (g) =>
          g.cloneSimple(repoUrl, dest, { token: TOKEN, username: "oauth2", ref: prCommit, sparse }),
        ),
      )

      expect(result._tag).toBe("Right")
      expect(fs.readFileSync(path.join(dest, "docs", "guide.md"), "utf8")).toBe("# guide (pr)\n")
      expect(fs.readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(TOKEN)
    }
    expect(spawns.some((s) => s.args[0] === "fetch" && s.args.includes(prCommit))).toBe(true)
    expect(tokenInAnyArg()).toBe(false)
    expect(server.seenAuthorization.every((h) => h === basic("oauth2", TOKEN))).toBe(true)
  }, 30_000)

  it("pushes with the given username and never rewrites the remote URL", async () => {
    const work = path.join(root, "push-work")
    git(root, "clone", path.join(root, "server", "repo.git"), work)
    git(work, "remote", "set-url", "origin", repoUrl)
    git(work, "checkout", "-b", "feature")
    fs.writeFileSync(path.join(work, "new.txt"), "new\n")
    git(work, "add", "new.txt")
    git(work, "commit", "-m", "add new")
    const configBefore = fs.readFileSync(path.join(work, ".git", "config"), "utf8")
    spawns.length = 0

    const result = await run(
      Effect.flatMap(GitClient, (g) =>
        g.push(work, "origin", "feature", { token: TOKEN, username: "oauth2", setUpstream: true }),
      ),
    )

    expect(result._tag).toBe("Right")
    expect(gitOut(path.join(root, "server", "repo.git"), "branch", "--list", "feature")).toContain("feature")
    expect(server.seenAuthorization).toContain(basic("oauth2", TOKEN))
    expect(spawns.some((s) => s.args.includes("set-url"))).toBe(false)
    expect(tokenInAnyArg()).toBe(false)
    // Only the upstream tracking section is new; the remote URL is untouched.
    const configAfter = fs.readFileSync(path.join(work, ".git", "config"), "utf8")
    expect(configAfter).not.toContain(TOKEN)
    expect(configAfter.startsWith(configBefore)).toBe(true)
  }, 30_000)

  it("pushes with the fresh token when the remote URL still carries an old one", async () => {
    // Checkouts cloned before tokens stopped going into the URL keep a stale
    // one in .git/config; the push must authenticate with the current token.
    const work = path.join(root, "push-stale")
    git(root, "clone", path.join(root, "server", "repo.git"), work)
    git(work, "remote", "set-url", "origin", repoUrl.replace("http://", "http://x-access-token:STALE@"))
    git(work, "checkout", "-b", "stale-feature")
    git(work, "commit", "--allow-empty", "-m", "empty")

    const result = await run(
      Effect.flatMap(GitClient, (g) =>
        g.push(work, "origin", "stale-feature", { token: TOKEN, username: "oauth2" }),
      ),
    )

    expect(result._tag).toBe("Right")
    expect(server.seenAuthorization).toContain(basic("oauth2", TOKEN))
    expect(server.seenAuthorization).not.toContain(basic("x-access-token", "STALE"))
  }, 30_000)

  it("does not send the token to a push URL on another origin", async () => {
    // The caller bound the token to origin's fetch URL; a pushurl (or
    // pushInsteadOf) pointing at another host must not receive it.
    const work = path.join(root, "push-other-origin")
    git(root, "clone", path.join(root, "server", "repo.git"), work)
    git(work, "remote", "set-url", "origin", repoUrl)
    git(work, "remote", "set-url", "--push", "origin", repoUrl.replace("127.0.0.1", "localhost"))
    git(work, "checkout", "-b", "other-origin")
    git(work, "commit", "--allow-empty", "-m", "empty")

    await run(Effect.flatMap(GitClient, (g) => g.push(work, "origin", "other-origin", { token: TOKEN, username: "oauth2" })))

    expect(server.seenAuthorization).not.toContain(basic("oauth2", TOKEN))
    const push = spawns.find((s) => s.args[0] === "push")
    expect(push?.env?.GIT_CONFIG_COUNT).toBe(process.env.GIT_CONFIG_COUNT)
  }, 30_000)

  it("never hands a rejected token's fallback to the user's credential helper", async () => {
    // Without resetting credential.helper, a 401 makes git ask the user's
    // helper for a login and then tell it to erase that login when it fails.
    const dest = path.join(root, "clone-rejected")

    const result = await run(
      Effect.flatMap(GitClient, (g) => g.cloneSimple(repoUrl, dest, { token: "wrong-token", username: "oauth2" })),
    )

    expect(result._tag).toBe("Left")
    expect(server.seenAuthorization).toContain(basic("oauth2", "wrong-token"))
    expect(fs.existsSync(helperLog)).toBe(false)
  }, 30_000)

  it("pushes to an SSH remote without rewriting its URL or passing the token", async () => {
    // Rewriting ssh://git@host:2222/... as ssh://x-access-token:<token>@host:2222/...
    // swaps the SSH user (publickey auth fails) and leaks the token into ssh's argv.
    const work = path.join(root, "push-ssh")
    git(root, "clone", path.join(root, "server", "repo.git"), work)
    const sshUrl = "ssh://git@127.0.0.1:1/group/proj.git"
    git(work, "remote", "set-url", "origin", sshUrl)
    spawns.length = 0

    // Nothing listens on port 1, so the push itself fails; what matters is how
    // it was attempted.
    await run(Effect.flatMap(GitClient, (g) => g.push(work, "origin", "main", { token: TOKEN })))

    expect(spawns.some((s) => s.args.includes("set-url"))).toBe(false)
    expect(tokenInAnyArg()).toBe(false)
    // No auth config appended: the count is whatever the environment already
    // carried (unset on most machines; some CI/sandbox shells export their own).
    const push = spawns.find((s) => s.args[0] === "push")
    expect(push?.env?.GIT_CONFIG_COUNT).toBe(process.env.GIT_CONFIG_COUNT)
    expect(gitOut(work, "remote", "get-url", "origin").trim()).toBe(sshUrl)
  }, 30_000)

  it("strips a token embedded in the origin URL from getInfo and getRemoteUrl", async () => {
    // A checkout cloned elsewhere with the token in its URL; what the layer
    // returns reaches the renderer (git:local-repo, workspace:tree).
    const work = path.join(root, "polluted")
    git(root, "clone", path.join(root, "server", "repo.git"), work)
    git(work, "remote", "set-url", "origin", `https://x-access-token:${TOKEN}@github.com/acme/infra.git`)

    const result = await run(
      Effect.flatMap(GitClient, (g) =>
        Effect.all([g.getInfo(work), g.getRemoteUrl(work)]),
      ),
    )

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      const [info, remoteUrl] = result.right
      expect(info.remoteUrl).toBe("https://github.com/acme/infra.git")
      expect(remoteUrl).toBe("https://github.com/acme/infra.git")
    }
  }, 30_000)
})
