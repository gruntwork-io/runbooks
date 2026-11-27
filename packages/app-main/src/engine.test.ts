import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
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

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runbooks-app-engine-")))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const userData = () => path.join(folder, "user data")

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
})
