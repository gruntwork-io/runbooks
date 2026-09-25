import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { resolveClonePaths } from "../../../src/domain/git/operations.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"
import {
  resolveRunbookAssetPath,
  validateCloneDestination,
  validateSessionPath,
} from "./path-guard.ts"
import { runbookConfig, sessionManager, setRunbookConfig } from "./runtime.ts"

// Layout, under a realpath'd temp root (macOS' /var is a symlink):
//   outside/secret.txt
//   outside/Documents/
//   work/runbook.mdx            <- the open runbook; work/ is the working dir
//   work/link -> ../outside     <- e.g. shipped in a cloned runbook repo
//   work/assets/ok.png
//   work/assets/my image.png
//   work/assets/leak.png   -> ../../outside/secret.txt
//   work/assets/leak x.png -> ../../outside/secret.txt
let root = ""
let outside = ""
let work = ""
let runbook = ""

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-path-guard-")))
  outside = path.join(root, "outside")
  work = path.join(root, "work")
  runbook = path.join(work, "runbook.mdx")
  fs.mkdirSync(path.join(outside, "Documents"), { recursive: true })
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret")
  fs.mkdirSync(path.join(work, "assets"), { recursive: true })
  fs.writeFileSync(runbook, "# Runbook")
  fs.symlinkSync("../outside", path.join(work, "link"))
  fs.writeFileSync(path.join(work, "assets", "ok.png"), "png")
  fs.writeFileSync(path.join(work, "assets", "my image.png"), "png")
  fs.symlinkSync("../../outside/secret.txt", path.join(work, "assets", "leak.png"))
  fs.symlinkSync("../../outside/secret.txt", path.join(work, "assets", "leak x.png"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("validateSessionPath", () => {
  // The workspace:* handlers (register, set-active, tree, dirs, file,
  // changes) and git:delete-branch validate with this and then use the path
  // it returns.
  const savedConfig = runbookConfig

  beforeEach(async () => {
    setRunbookConfig({ ...savedConfig, localPath: runbook })
    await Effect.runPromise(
      sessionManager.createSession(work, runbook).pipe(Effect.provide(makeTestEnvironment())),
    )
  })

  afterEach(() => {
    sessionManager.deleteSession()
    setRunbookConfig(savedConfig)
  })

  const validate = (p: string) => Effect.runPromise(Effect.either(validateSessionPath(p)))

  it("rejects a path in the session that is a symlink to outside it", async () => {
    // workspace:register with this path would otherwise make all of outside/
    // a trusted root.
    for (const p of [path.join(work, "link"), path.join(work, "link", "secret.txt")]) {
      const result = await validate(p)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("PathTraversalError")
    }
  })

  it("accepts a worktree registered outside the session", async () => {
    // git:local-repo registers the local checkout picked in a <GitClone> block.
    sessionManager.registerWorkTreePath(outside)
    const result = await validate(outside)
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") expect(result.right).toBe(outside)
    expect((await validate(path.join(outside, "secret.txt")))._tag).toBe("Right")
  })

  it("resolves a relative path against the runbook directory and returns it", async () => {
    // Callers must use the returned path: the raw relative path would be
    // resolved against the process cwd ("/" for a Finder-launched app).
    const result = await validate("Users/me/.ssh")
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") expect(result.right).toBe(path.join(work, "Users", "me", ".ssh"))
  })
})

describe("validateCloneDestination", () => {
  // Map a GitClone localPath to its destination exactly as git:clone does.
  const check = (localPath: string | undefined, workingDir = work, runbookPath = runbook) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { absolutePath } = yield* resolveClonePaths(
          localPath,
          "https://github.com/acme/repo.git",
          workingDir,
        )
        return yield* Effect.either(validateCloneDestination(absolutePath, workingDir, runbookPath))
      }),
    )

  const expectRejected = async (result: Awaited<ReturnType<typeof check>>, message: string) => {
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("PathTraversalError")
      expect(result.left.message).toContain(message)
    }
  }

  it.each([".", "./", "sub/..", "nested/../."])(
    "rejects %p, which resolves to the working directory itself",
    async (localPath) => {
      await expectRejected(await check(localPath), "must be a subdirectory")
    },
  )

  it("rejects the working directory's absolute path", async () => {
    await expectRejected(await check(work), "must be a subdirectory")
  })

  it("rejects the runbook's own directory once the working dir moved to its parent", async () => {
    // A Command block that runs `cd ..` leaves the session working dir at
    // root/, where "work" is a strict subdirectory that holds the runbook.
    await expectRejected(await check("work", root), "must not contain the open runbook")
    await expectRejected(await check(root, path.dirname(root)), "must not contain the open runbook")
  })

  it("rejects a destination reached through a symlink that points outside", async () => {
    await expectRejected(await check("link/Documents"), "outside session working directory")
    await expectRejected(await check("link"), "outside session working directory")
  })

  it("rejects a destination outside the working directory", async () => {
    await expectRejected(await check("../outside"), "outside session working directory")
    await expectRejected(await check(outside), "outside session working directory")
  })

  it.each(["repo", "nested/repo", undefined])("accepts %p", async (localPath) => {
    expect((await check(localPath))._tag).toBe("Right")
  })

  it("accepts a sibling of the runbook's directory from a parent working dir", async () => {
    expect((await check("other", root))._tag).toBe("Right")
  })

  it("skips the runbook check when the session has no runbook", async () => {
    expect((await check("work", root, ""))._tag).toBe("Right")
  })
})

describe("resolveRunbookAssetPath", () => {
  it("serves a regular file inside the runbook directory", async () => {
    expect(await resolveRunbookAssetPath("runbook-asset://assets/ok.png", work)).toBe(
      path.join(work, "assets", "ok.png"),
    )
  })

  it("percent-decodes the path so the checked path is the served path", async () => {
    expect(await resolveRunbookAssetPath("runbook-asset://assets/my%20image.png", work)).toBe(
      path.join(work, "assets", "my image.png"),
    )
  })

  it("refuses a symlink that points outside the runbook directory", async () => {
    expect(await resolveRunbookAssetPath("runbook-asset://assets/leak.png", work)).toBeNull()
  })

  it("refuses an outside symlink named with percent-encoding", async () => {
    // Checking the still-encoded "leak%20x.png" (which does not exist) would
    // pass, while the file:// fetch decodes it and follows the symlink.
    expect(await resolveRunbookAssetPath("runbook-asset://assets/leak%20x.png", work)).toBeNull()
  })

  it("refuses traversal, including percent-encoded separators", async () => {
    // The URL parser keeps `..` path segments below the host, so a host of
    // ".." is the only literal way up.
    expect(await resolveRunbookAssetPath("runbook-asset://../outside/secret.txt", work)).toBeNull()
    expect(
      await resolveRunbookAssetPath("runbook-asset://assets/..%2F..%2Foutside%2Fsecret.txt", work),
    ).toBeNull()
  })

  it("refuses malformed percent-encoding", async () => {
    expect(await resolveRunbookAssetPath("runbook-asset://assets/%E0%A4%A.png", work)).toBeNull()
  })
})
