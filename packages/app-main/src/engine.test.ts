import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { EngineClient } from "@runbooks/core/protocol"
import { appEngine } from "./engine.ts"

// The app's engine over a real user data folder, the real Node layers and
// bash, driven as a client drives it.

/** A runbook whose `setup` block writes a file in the folder it runs in. */
const FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/end-to-end")
/** A runbook whose block's script, stopped, cleans up with the block's files. */
const TRAP_FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/trap")
/** A runbook of three blocks whose scripts, stopped, take two seconds to clean up. */
const CLOSE_FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/close")
const STUCK = ["one", "two", "three"].map((id) => Schema.decodeSync(BlockId)(id))

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runbooks-app-engine-")))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const userData = () => path.join(folder, "user data")

/** Opens the close fixture in `client`, trusts it, and runs `blocks`, each until its script has started. */
const runStuck = (client: EngineClient, blocks: ReadonlyArray<BlockId>) =>
  Effect.gen(function* () {
    const result = yield* client.OpenSession({ path: path.join(CLOSE_FIXTURE, "runbook.mdx") })
    if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join())
    const { session, trust } = result.session
    yield* client.TrustSession({ session, hash: trust.hash })
    for (const block of blocks) {
      yield* client.RunBlock({ session, block })
      const started = Effect.map(client.GetBlock({ session, block }), (view) =>
        (view.log?.lines ?? []).some((line) => line.text === "started"),
      )
      while (!(yield* started)) yield* Effect.sleep("20 millis")
    }
    return session
  })

/** The files the close fixture's traps wrote in `session`'s folder, one for each stopped script. */
const stoppedIn = (session: string) =>
  readdirSync(path.join(userData(), "v0", "sessions", "dirs", session)).filter((file) =>
    file.startsWith("stopped-"),
  )

const withClient = <A>(
  use: (client: EngineClient) => Effect.Effect<A, unknown>,
  env: Record<string, string> = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeInProcessClient("person"), use)).pipe(
      Effect.provide(
        appEngine({
          userData: userData(),
          appVersion: "0.31.0",
          processEnvironment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
        }),
      ),
    ),
  )

describe("the app's engine", () => {
  it("keeps its settings in settings.json, in the user data folder", async () => {
    const file = path.join(userData(), "settings.json")
    const shown = await withClient((client) =>
      Effect.gen(function* () {
        const before = yield* client.GetSettings()
        yield* client.ChangeSettings({ changes: { theme: "dark" } })
        return before.file
      }),
    )
    expect(shown).toBe(file)
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ settings: { theme: "dark" } })
  })

  it("runs a session's tasks in its working folder, under v0/sessions/dirs in the user data folder", async () => {
    const opened = await withClient((client) =>
      Effect.gen(function* () {
        const result = yield* client.OpenSession({ path: path.join(FIXTURE, "runbook.mdx") })
        if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join())
        const { session: id, trust } = result.session
        yield* client.TrustSession({ session: id, hash: trust.hash })
        // It writes generated/made-by-setup.txt in the folder it starts in.
        const target = { session: id, block: Schema.decodeSync(BlockId)("setup") }
        yield* client.RunBlock(target)
        const ended = yield* client.WaitForBlock({ ...target, timeoutMillis: 10_000 })
        return { id, status: ended.block.status }
      }),
    )
    expect(opened.status).toEqual({ _tag: "Done", outcome: "success" })
    const working = path.join(userData(), "v0", "sessions", "dirs", opened.id)
    expect(readFileSync(path.join(working, "generated", "made-by-setup.txt"), "utf8")).toBe(
      "made\n",
    )
  })

  it("keeps a cancelled Command's folders until its script's TERM trap has ended, then removes them", async () => {
    const stopped = await withClient(
      (client) =>
        Effect.gen(function* () {
          const result = yield* client.OpenSession({ path: path.join(TRAP_FIXTURE, "runbook.mdx") })
          if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join())
          const { session, trust } = result.session
          yield* client.TrustSession({ session, hash: trust.hash })
          const target = { session, block: Schema.decodeSync(BlockId)("cleanup") }
          yield* client.RunBlock(target)
          const started = Effect.map(client.GetBlock(target), (view) =>
            (view.log?.lines ?? []).some((line) => line.text === "started"),
          )
          while (!(yield* started)) yield* Effect.sleep("20 millis")
          yield* client.CancelBlock(target)
          const trapRan = path.join(userData(), "v0", "sessions", "dirs", session, "trap-ran")
          return {
            trapRan,
            ended: existsSync(trapRan),
            status: (yield* client.GetBlock(target)).status,
          }
        }),
      { CLEANUP_RUNS_FOR: "300" },
    )
    expect(stopped.status).toMatchObject({ _tag: "Failed", error: { _tag: "TaskCancelled" } })
    for (let waited = 0; !existsSync(stopped.trapRan) && waited < 10_000; waited += 50)
      await Bun.sleep(50)
    expect(readFileSync(stopped.trapRan, "utf8")).toBe("kept kept\n")
    // CancelBlock answered once the trap had ended.
    expect(stopped.ended).toBe(true)
    const folders = readFileSync(path.join(path.dirname(stopped.trapRan), "folders"), "utf8")
    expect(folders.trim().split("\n")).toHaveLength(2)
    for (const file of folders.trim().split("\n"))
      expect(existsSync(path.dirname(file))).toBe(false)
  })

  // Each trap takes two seconds: stopped in turn, three take six.
  it("stops a closing session's running scripts at once, each with its grace", async () => {
    const closed = await withClient(
      (client) =>
        Effect.gen(function* () {
          const session = yield* runStuck(client, STUCK)
          const began = Date.now()
          yield* client.CloseSession({ session })
          return { session, took: Date.now() - began }
        }),
      { CLOSE_RUNS_FOR: "300" },
    )
    expect(stoppedIn(closed.session)).toHaveLength(3)
    expect(closed.took).toBeLessThan(4000)
  }, 30_000)

  it("stops every session's running scripts at once when the engine closes", async () => {
    let began = 0
    const sessions = await withClient(
      (client) =>
        Effect.gen(function* () {
          const opened = [
            yield* runStuck(client, STUCK.slice(0, 1)),
            yield* runStuck(client, STUCK.slice(0, 1)),
          ]
          began = Date.now()
          return opened
        }),
      { CLOSE_RUNS_FOR: "300" },
    )
    const took = Date.now() - began
    for (const session of sessions) expect(stoppedIn(session)).toHaveLength(1)
    expect(took).toBeLessThan(3500)
  }, 30_000)
})
