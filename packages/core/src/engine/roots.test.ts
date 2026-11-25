/**
 * The folders a run uses: the engine sets each, no command names one, and a
 * path a task names stays inside its root. The clone tests are today's
 * `electron/main/ipc/path-guard.test.ts` ones, by name; those that need a
 * real symbolic link run against the real filesystem in platform-node.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { BlockId, PathOutsideRoot, type Root } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { type UseRootsSession, withRootsSession } from "../test-utils/rootSessions.ts"
import { testCredentialProviders } from "../test-utils/TestCredentialProviders.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

/** One trusted session of `runbook` at /rb/runbook.mdx, its working folders in /work. */
const withSession = <A, E>(runbook: string, use: UseRootsSession<A, E>) =>
  withRootsSession(
    {
      file: RUNBOOK,
      workingFolders: "/work",
      fileSystem: makeTestFileSystem({ [RUNBOOK]: runbook }),
    },
    use,
  )

const done: BlockStatus = { _tag: "Done", outcome: "success" }

/** A run that failed because `path`, which it named in `root`, left it. */
const failedOn = (root: Root, path: string, message: string): BlockStatus => ({
  _tag: "Failed",
  error: new PathOutsideRoot({ root, path, message }),
})
const outside = (root: Root, folder: string, path: string) =>
  failedOn(root, path, `${path} is outside the ${root} folder, ${folder}.`)
const itself = (path: string) =>
  failedOn(
    "working",
    path,
    `${path} is the working folder itself; a repository goes in a folder inside it.`,
  )

describe("the roots", () => {
  it("are the runbook's folder and the session's own working folder, which the engine sets", async () => {
    const runbook = '<Touch id="a" label="a" root="working" path="out.txt" />'
    const runOnce = () =>
      withSession(runbook, (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("a")).toEqual(done)
          const input = rb.seen.get("a")
          if (input === undefined) throw new Error("a did not run")
          return { working: rb.working, input }
        }),
      )
    const one = await runOnce()
    const two = await runOnce()
    expect(one.input.roots).toEqual({
      runbook: "/rb",
      working: one.working,
      generated: `${one.working}/generated`,
    })
    expect(one.input.cwd).toBe(one.working)
    expect(one.input.paths).toEqual({ target: `${one.working}/out.txt` })
    // Two sessions of one runbook never share a working folder.
    expect(two.working).not.toBe(one.working)
    expect(two.input.cwd).toBe(two.working)
  })

  it("refuses a runbook opened by a relative path, which would make its folder the engine's", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* Engine
        return yield* Effect.flip(engine.openSession({ path: "rb/runbook.mdx" }))
      }).pipe(
        Effect.provide(
          Engine.layer({
            registry: TOY_REGISTRY,
            appVersion: "0.31.0",
            workingFolders: "/work",
            stateFolders: "/state",
            processEnvironment: {},
          }),
        ),
        Effect.provide(testCredentialProviders({}, [])),
        Effect.provide(testSettingsStore()),
        Effect.provide(makeTestFileSystem({ "rb/runbook.mdx": '<Run id="a" />' })),
      ),
    )
    expect(result).toMatchObject({
      _tag: "RunbookUnreadable",
      path: "rb/runbook.mdx",
      message: "rb/runbook.mdx is not an absolute path.",
    })
  })
})

describe("a path a task names", () => {
  it("resolves inside its root, absolute or not", async () => {
    const runbook = [
      '<Touch id="script" label="script" root="runbook" path="scripts/a.sh" />',
      '<Touch id="plan" label="plan" root="generated" path="infra/main.tf" />',
      '<Touch id="here" label="here" root="working" path="/work" />',
    ].join("\n\n")
    await withSession(runbook, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("script")).toEqual(done)
        expect(yield* rb.run("plan")).toEqual(done)
        expect(rb.seen.get("script")?.paths).toEqual({ target: "/rb/scripts/a.sh" })
        expect(rb.seen.get("plan")?.paths).toEqual({
          target: `${rb.working}/generated/infra/main.tf`,
        })
        // `/work` holds every session's working folder, not just this one's.
        expect(yield* rb.run("here")).toEqual(outside("working", rb.working, "/work"))
      }),
    )
  })

  it("fails the run when it leaves its root, saying which root and which path", async () => {
    const runbook = [
      '<Touch id="up" label="up" root="working" path="../other" />',
      '<Touch id="etc" label="etc" root="runbook" path="/etc/passwd" />',
      '<Touch id="lost" label="lost" root="repository" path="README.md" />',
    ].join("\n\n")
    await withSession(runbook, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("up")).toEqual(outside("working", rb.working, "../other"))
        expect(yield* rb.run("etc")).toEqual(outside("runbook", "/rb", "/etc/passwd"))
        expect(yield* rb.run("lost")).toEqual(
          failedOn(
            "repository",
            "README.md",
            "README.md is in a repository, and the block names none.",
          ),
        )
        expect(rb.seen.size).toBe(0)
      }),
    )
  })
})

describe("a clone's target", () => {
  /** Runs a clone whose `localPath` field a client set, `<working>` standing for the working folder. */
  const cloneTo = (localPath: string) =>
    withSession('<Clone id="clone" label="clone" />', (rb) =>
      Effect.gen(function* () {
        const written = localPath.replace("<working>", rb.working)
        yield* rb.set("clone", { localPath: written })
        return { status: yield* rb.run("clone"), working: rb.working, written }
      }),
    )

  it.each([".", "./", "sub/..", "nested/../."])(
    "rejects %p, which resolves to the working directory itself",
    async (localPath) => {
      expect((await cloneTo(localPath)).status).toEqual(itself(localPath))
    },
  )

  it("rejects the working directory's absolute path", async () => {
    const { status, working } = await cloneTo("<working>")
    expect(status).toEqual(itself(working))
  })

  it("rejects a destination outside the working directory", async () => {
    for (const localPath of ["../outside", "/outside"]) {
      const { status, working } = await cloneTo(localPath)
      expect(status).toEqual(outside("working", working, localPath))
    }
  })

  it.each(["repo", "nested/repo", "<working>/repo"])("accepts %p", async (localPath) => {
    expect((await cloneTo(localPath)).status).toEqual(done)
  })

  it("is the repository a task that names it starts in, and resolves its paths inside", async () => {
    const runbook = [
      '<Clone id="clone" label="clone" localPath="infra" />',
      '<Touch id="read" label="read" root="repository" path="README.md" repository="clone" />',
      '<Touch id="escape" label="escape" root="repository" path="../secret" repository="clone" />',
    ].join("\n\n")
    await withSession(runbook, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("clone")).toEqual(done)
        expect(yield* rb.run("read")).toEqual(done)
        const repository = `${rb.working}/infra`
        expect(rb.seen.get("read")?.cwd).toBe(repository)
        expect(rb.seen.get("read")?.paths).toEqual({ target: `${repository}/README.md` })
        expect(rb.seen.get("read")?.repository).toEqual(
          Option.some({ block: blockId("clone"), path: repository, remoteUrl: Option.none() }),
        )
        expect(yield* rb.run("escape")).toEqual(outside("repository", repository, "../secret"))
      }),
    )
  })
})
