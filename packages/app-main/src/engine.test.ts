import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
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

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runbooks-app-engine-")))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const userData = () => path.join(folder, "user data")

const withClient = <A>(use: (client: EngineClient) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(makeInProcessClient("person"), use)).pipe(
      Effect.provide(
        appEngine({
          userData: userData(),
          appVersion: "0.31.0",
          processEnvironment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
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
})
