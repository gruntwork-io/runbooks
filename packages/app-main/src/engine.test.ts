import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { BlockId } from "@runbooks/blocks-core/contract"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { EngineClient } from "@runbooks/core/protocol"
import { MAX_SESSION_AGE_MILLIS } from "@runbooks/core/sessionStore"
import { testSessionCipher } from "@runbooks/core/test-utils/TestSessionCipher"
import { appEngine, fakeCredentialsOn } from "./engine.ts"

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

interface ClientOptions {
  /** Added to the engine's process environment. */
  readonly env?: Readonly<Record<string, string>>
  readonly fakeCredentials?: boolean
  /** The test cipher's key: 1 unless given. */
  readonly cipherKey?: number
  /** When the engine starts, on a test clock, in milliseconds since the epoch. The real clock unless given. */
  readonly startsAt?: number
}

/** Runs `use` with a client of an app engine on the user data folder, which closes once it is done. */
const withClient = <A>(
  use: (client: EngineClient) => Effect.Effect<A, unknown>,
  options: ClientOptions = {},
): Promise<A> => {
  const { env = {}, fakeCredentials = false, cipherKey = 1, startsAt } = options
  const program = Effect.scoped(Effect.flatMap(makeInProcessClient("person"), use)).pipe(
    Effect.provide(
      appEngine({
        userData: userData(),
        appVersion: "0.31.0",
        processEnvironment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
        fakeCredentials,
        sessionCipher: testSessionCipher({ key: cipherKey }),
      }),
    ),
  )
  return Effect.runPromise(
    startsAt === undefined
      ? program
      : Effect.andThen(TestClock.setTime(startsAt), program).pipe(
          Effect.provide(TestClock.layer()),
        ),
  )
}

/** AwsAuth's testdata: `aws` looks in the environment for the fake's secret key. */
const AWS_FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/aws-auth/testdata/detect")

/** Inputs' testdata: `config` is a form whose required Name starts empty. */
const INPUTS_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../blocks/inputs/testdata/end-to-end",
)
const CONFIG = Schema.decodeSync(BlockId)("config")

/** Opens the runbook in `fixture`, and trusts it as a person does. */
const openTrusted = (client: EngineClient, fixture: string) =>
  Effect.gen(function* () {
    const result = yield* client.OpenSession({ path: path.join(fixture, "runbook.mdx") })
    if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join())
    const { session, trust } = result.session
    yield* client.TrustSession({ session, hash: trust.hash })
    return session
  })

/** Opens Inputs' runbook: the session it gets, whether it is trusted, what its resume did not restore, and config's Name. */
const reopen = (client: EngineClient) =>
  Effect.gen(function* () {
    const result = yield* client.OpenSession({ path: path.join(INPUTS_FIXTURE, "runbook.mdx") })
    if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join())
    const { session, trust, resumed } = result.session
    const { fields } = yield* client.GetBlock({ session, block: CONFIG })
    return {
      session,
      trusted: trust.trusted,
      problems: resumed?.problems,
      name: fields?.find((field) => field.name === "Name")?.value,
    }
  })

describe("the app's engine", () => {
  it("signs credential blocks in against the fakes only unpackaged, when RUNBOOKS_FAKE_CREDENTIALS=1 asks", () => {
    const on = { RUNBOOKS_FAKE_CREDENTIALS: "1" }
    expect(fakeCredentialsOn(false, on)).toBe(true)
    expect(fakeCredentialsOn(true, on)).toBe(false)
    expect(fakeCredentialsOn(false, {})).toBe(false)
    expect(fakeCredentialsOn(false, { RUNBOOKS_FAKE_CREDENTIALS: "true" })).toBe(false)
  })

  it("finds the fake's login for a credential block in dev mode, and opens no provider otherwise", async () => {
    const stateOf = (fakeCredentials: boolean) =>
      withClient(
        (client) =>
          Effect.gen(function* () {
            const result = yield* client.OpenSession({
              path: path.join(AWS_FIXTURE, "runbook.mdx"),
            })
            if (result._tag !== "Opened")
              throw new Error(result.errors.map((e) => e.message).join())
            const { session, trust } = result.session
            yield* client.TrustSession({ session, hash: trust.hash })
            const target = { session, block: Schema.decodeSync(BlockId)("aws") }
            for (;;) {
              const { block } = yield* client.WaitForBlock({ ...target, timeoutMillis: 1_000 })
              if (block.status?._tag !== "Running") return block.credential
            }
          }),
        { env: { AWS_SECRET_ACCESS_KEY: "fake-aws-secret-0001" }, fakeCredentials },
      )
    expect(await stateOf(true)).toMatchObject({ _tag: "Found", source: "env" })
    expect(await stateOf(false)).toMatchObject({
      _tag: "Unavailable",
      error: { kind: "providerFailed" },
    })
  })

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

  it("keeps a session in v0/sessions/db/sessions.db, and resumes it, trusted and with its values, once the engine starts again", async () => {
    const before = await withClient((client) =>
      Effect.gen(function* () {
        const session = yield* openTrusted(client, INPUTS_FIXTURE)
        yield* client.SetValues({ session, block: CONFIG, values: { Name: "web" } })
        return session
      }),
    )
    expect(existsSync(path.join(userData(), "v0", "sessions", "db", "sessions.db"))).toBe(true)
    expect(await withClient(reopen)).toEqual({
      session: before,
      trusted: true,
      problems: [],
      name: { _tag: "Shown", value: "web" },
    })
    // The cipher it is given encrypted them: one with another key reads neither form's.
    expect(await withClient(reopen, { cipherKey: 2 })).toEqual({
      session: before,
      trusted: true,
      problems: [{ _tag: "Unreadable", blocks: [CONFIG, Schema.decodeSync(BlockId)("who")] }],
      name: undefined,
    })
  })

  it("drops a session unused for MAX_SESSION_AGE_MILLIS, with its working folder, when the engine starts", async () => {
    const before = await withClient((client) =>
      Effect.gen(function* () {
        const session = yield* openTrusted(client, FIXTURE)
        const target = { session, block: Schema.decodeSync(BlockId)("setup") }
        yield* client.RunBlock(target)
        yield* client.WaitForBlock({ ...target, timeoutMillis: 10_000 })
        return session
      }),
    )
    const working = path.join(userData(), "v0", "sessions", "dirs", before)
    expect(readdirSync(working)).toContain("generated")
    const after = await withClient(
      (client) =>
        Effect.map(client.OpenSession({ path: path.join(FIXTURE, "runbook.mdx") }), (result) =>
          result._tag === "Opened" ? result.session.session : undefined,
        ),
      { startsAt: Date.now() + MAX_SESSION_AGE_MILLIS + 60_000 },
    )
    expect(existsSync(working)).toBe(false)
    expect(after).toBeString()
    expect(after).not.toBe(before)
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
      { env: { CLEANUP_RUNS_FOR: "300" } },
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
      { env: { CLOSE_RUNS_FOR: "300" } },
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
      { env: { CLOSE_RUNS_FOR: "300" } },
    )
    const took = Date.now() - began
    for (const session of sessions) expect(stoppedIn(session)).toHaveLength(1)
    expect(took).toBeLessThan(3500)
  }, 30_000)
})
