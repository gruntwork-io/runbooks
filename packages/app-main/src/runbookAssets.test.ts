import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { appEngine } from "./engine.ts"
import { runbookAsset, type SessionRunbook, sessionRunbook } from "./runbookAssets.ts"

// Layout, under a realpath'd temp root (macOS' /var is a symlink):
//   outside/secret.txt
//   work/runbook.mdx            <- the open runbook, session HOST
//   work/link -> ../outside     <- e.g. shipped in a cloned runbook repo
//   work/assets/ok.png
//   work/assets/my image.png
//   work/assets/leak.png   -> ../../outside/secret.txt
//   work/assets/leak x.png -> ../../outside/secret.txt
//   elsewhere/runbook.mdx       <- another open runbook, session OTHER
//   elsewhere/assets/
let root = ""
let outside = ""
let work = ""

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-assets-")))
  outside = path.join(root, "outside")
  work = path.join(root, "work")
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret")
  fs.mkdirSync(path.join(work, "assets"), { recursive: true })
  fs.writeFileSync(path.join(work, "runbook.mdx"), "# Runbook")
  fs.symlinkSync("../outside", path.join(work, "link"))
  fs.writeFileSync(path.join(work, "assets", "ok.png"), "png")
  fs.writeFileSync(path.join(work, "assets", "my image.png"), "png")
  fs.symlinkSync("../../outside/secret.txt", path.join(work, "assets", "leak.png"))
  fs.symlinkSync("../../outside/secret.txt", path.join(work, "assets", "leak x.png"))
  fs.mkdirSync(path.join(root, "elsewhere", "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "elsewhere", "runbook.mdx"), "# Elsewhere")
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const HOST = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const OTHER = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b"

describe("runbookAsset", () => {
  /** HOST's session has the runbook in `runbookDir` open, and OTHER's the one in elsewhere/. */
  const sessions =
    (runbookDir: string): SessionRunbook =>
    (host) =>
      Effect.succeed(
        host === HOST
          ? path.join(runbookDir, "runbook.mdx")
          : host === OTHER
            ? path.join(root, "elsewhere", "runbook.mdx")
            : undefined,
      )
  const find = (url: string, runbookOf: SessionRunbook) =>
    Effect.runPromise(runbookAsset(url, runbookOf).pipe(Effect.provide(NodeFileSystemLive)))
  /** Resolve `assetPath`, a path in assets/, as the open runbook's runbook-asset://<HOST>/<assetPath>. */
  const resolve = (assetPath: string, runbookDir = work) =>
    find(`runbook-asset://${HOST}/${assetPath}`, sessions(runbookDir))

  it("serves a regular file from the assets folder, which is the host's root", async () => {
    expect(await resolve("ok.png")).toBe(path.join(work, "assets", "ok.png"))
  })

  it("refuses another runbook's host", async () => {
    expect(await find(`runbook-asset://${OTHER}/ok.png`, sessions(work))).toBeUndefined()
    // A session that is not open.
    const closed = "3f2c8e41-5d7a-4b9e-8c1f-0a6b2d9e7c55"
    expect(await find(`runbook-asset://${closed}/ok.png`, sessions(work))).toBeUndefined()
    // The host every runbook shared in the old app, before hosts were per runbook.
    expect(await find("runbook-asset://assets/ok.png", sessions(work))).toBeUndefined()
  })

  it("refuses a host that is not a session id, even one the engine would answer for", async () => {
    const anyHost: SessionRunbook = () => Effect.succeed(path.join(work, "runbook.mdx"))
    for (const host of ["127.0.0.1", "0x7f000001", "[::1]", "localhost", HOST.toUpperCase()])
      expect(await find(`runbook-asset://${host}/ok.png`, anyHost)).toBeUndefined()
  })

  it("percent-decodes the path so the checked path is the served path", async () => {
    expect(await resolve("my%20image.png")).toBe(path.join(work, "assets", "my image.png"))
  })

  it("refuses a symlink that points outside the runbook directory", async () => {
    expect(await resolve("leak.png")).toBeUndefined()
  })

  it("refuses an outside symlink named with percent-encoding", async () => {
    // Checking the still-encoded "leak%20x.png" (which does not exist) would
    // pass, while the file it serves is the decoded name, a symlink out.
    expect(await resolve("leak%20x.png")).toBeUndefined()
  })

  it("refuses traversal, including percent-encoded separators", async () => {
    expect(await resolve("..%2Frunbook.mdx")).toBeUndefined()
    expect(await resolve("..%2F..%2Foutside%2Fsecret.txt")).toBeUndefined()
    expect(await resolve("..%2Flink%2Fsecret.txt")).toBeUndefined()
  })

  it("refuses malformed percent-encoding", async () => {
    expect(await resolve("%E0%A4%A.png")).toBeUndefined()
  })

  it("refuses files in the runbook directory outside assets/", async () => {
    fs.mkdirSync(path.join(work, "generated"))
    fs.writeFileSync(path.join(work, "generated", "out.txt"), "output")
    expect(await resolve("..%2Fgenerated%2Fout.txt")).toBeUndefined()
  })

  it("refuses everything when assets/ is a symlink out of the runbook directory", async () => {
    const linked = path.join(root, "linked")
    fs.mkdirSync(linked)
    fs.symlinkSync("../outside", path.join(linked, "assets"))
    expect(await resolve("secret.txt", linked)).toBeUndefined()
  })

  it.each([
    ["the runbook directory", "."],
    ["another folder in the runbook directory", "generated"],
  ])("refuses everything when assets/ is a symlink to %s", async (_name, target) => {
    const linked = path.join(root, "linked")
    fs.mkdirSync(path.join(linked, "generated"), { recursive: true })
    fs.writeFileSync(path.join(linked, "runbook.mdx"), "# Runbook")
    fs.writeFileSync(path.join(linked, "generated", "out.txt"), "output")
    fs.symlinkSync(target, path.join(linked, "assets"))
    expect(await resolve("generated/out.txt", linked)).toBeUndefined()
    expect(await resolve("out.txt", linked)).toBeUndefined()
    expect(await resolve("runbook.mdx", linked)).toBeUndefined()
  })

  it("refuses everything when the runbook has no assets/ folder", async () => {
    fs.rmSync(path.join(work, "assets"), { recursive: true })
    expect(await resolve("ok.png")).toBeUndefined()
  })

  it("serves no folder", async () => {
    fs.mkdirSync(path.join(work, "assets", "icons"))
    expect(await resolve("")).toBeUndefined()
    expect(await resolve("icons")).toBeUndefined()
  })

  it("takes a session id as written: a URL parser reads it as a host, never as an IP address", () => {
    // http: parses hosts as Chromium parses a standard scheme's.
    for (let i = 0; i < 1000; i++) {
      const id = crypto.randomUUID()
      expect(new URL(`http://${id}/`).hostname).toBe(id)
    }
    expect(new URL("http://12345678-1234-1234-1234-123456789012/").hostname).toBe(
      "12345678-1234-1234-1234-123456789012",
    )
  })
})

describe("sessionRunbook", () => {
  it("finds the runbook the engine's session has open by the session's id, and none for another id", async () => {
    const runbook = path.join(work, "runbook.mdx")
    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeInProcessClient("person")
          const opened = yield* client.OpenSession({ path: runbook })
          if (opened._tag !== "Opened") throw new Error("the runbook did not open")
          const runbookOf = sessionRunbook(client)
          return {
            own: yield* runbookOf(opened.session.session),
            other: yield* runbookOf(OTHER),
            asset: yield* runbookAsset(
              `runbook-asset://${opened.session.session}/ok.png`,
              runbookOf,
            ),
          }
        }),
      ).pipe(
        Effect.provide(NodeFileSystemLive),
        Effect.provide(
          appEngine({
            userData: path.join(root, "user data"),
            appVersion: "0.31.0",
            processEnvironment: {},
          }),
        ),
      ),
    )
    expect(found).toEqual({
      own: runbook,
      other: undefined,
      asset: path.join(work, "assets", "ok.png"),
    })
  })
})
