/**
 * The credential client against the fake plugin as a process, through the
 * transport owner and the real filesystem: what the in-memory tests
 * (`@runbooks/core/credential/plugin.test.ts`) cannot show. Each test has
 * its own temporary folder, bin folder and HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Option, Redacted, Stream } from "effect"
import type { CredentialError } from "@runbooks/blocks-core/contract"
import { FAKE_SCRIPT, type FakeScript } from "@runbooks/core/credential/fake"
import {
  type Constraints,
  type CredentialProvider,
  CredentialProviders,
} from "@runbooks/core/credential/provider"
import { prepareStateDir } from "@runbooks/core/credential/stateDir"
import { installFake, pluginProviders } from "./pluginBin.ts"

const NONE: Constraints = { pins: {}, requirements: [] }
const TOKEN = "fake-token-0001-secret"

let root = ""
let state = ""
let starts = ""
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-client-")))
  state = path.join(root, "state", "s1", "fake")
  starts = path.join(root, "starts")
  mkdirSync(path.join(root, "bin"))
  mkdirSync(path.join(root, "run"), { mode: 0o700 })
  mkdirSync(path.join(root, "home"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Each process the fake started, by process id, in order. */
const started = () =>
  readFileSync(starts, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(Number)

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Opens the fake's provider as the engine does: its state folder made
 * first, with only `environment` and the variables Bun needs.
 */
const withFake = <A, E>(
  use: (provider: CredentialProvider) => Effect.Effect<A, E>,
  options: { readonly script?: FakeScript; readonly environment?: Record<string, string> } = {},
): Promise<A> => {
  const entry = installFake(path.join(root, "bin"))
  const environment = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(root, "home"),
    FAKE_STARTS: starts,
    ...options.environment,
  }
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* prepareStateDir(state)
        const providers = yield* CredentialProviders
        const provider = yield* providers.open("fake", {
          stateDir: state,
          environment: new Map(Object.entries(environment).map(([k, v]) => [k, Redacted.make(v)])),
          caBundleFile: Option.none(),
          proxy: Option.none(),
          settings:
            options.script === undefined ? {} : { fakeScript: JSON.stringify(options.script) },
        })
        yield* provider.describe
        return yield* use(provider)
      }),
    ).pipe(
      Effect.provide(pluginProviders(path.join(root, "bin"), path.join(root, "run"), [entry])),
    ),
  )
}

const signIn = (provider: CredentialProvider, method: string, fields: Record<string, string>) =>
  provider.signIn(
    method,
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Redacted.make(v)])),
    NONE,
  )

const failure = <A>(effect: Effect.Effect<A, CredentialError>) => Effect.flip(effect)

describe("a plugin-backed provider, as a process", () => {
  it("signs in, gives env an owner-only file in the state folder, and signing out leaves the folder empty", async () => {
    const result = await withFake((provider) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(signIn(provider, "token", { token: TOKEN }))
        const env = yield* provider.env
        const file = env.values.find((value) => value.file)
        const mode = file === undefined ? 0 : statSync(Redacted.value(file.value)).mode & 0o777
        const during = readdirSync(state)
        yield* provider.signOut
        return { mode, during, after: readdirSync(state) }
      }),
    )
    expect(result).toEqual({ mode: 0o600, during: ["credentials.json"], after: [] })
    expect(statSync(state).mode & 0o777).toBe(0o700)
  })

  it("runs the plugin with the environment the engine built, not the app's", async () => {
    const before = process.env["FAKE_TOKEN"]
    process.env["FAKE_TOKEN"] = TOKEN
    try {
      const [without, given] = await Promise.all([
        withFake((provider) => provider.detect([{ kind: "env", prefix: Option.none() }], NONE)),
        withFake((provider) => provider.detect([{ kind: "env", prefix: Option.none() }], NONE), {
          environment: { FAKE_TOKEN: "fake-cli-token-0001" },
        }),
      ])
      expect(Option.isNone(without)).toBe(true)
      expect(Option.map(given, ({ identity }) => identity.principal)).toEqual(
        Option.some("fake-cli@example.com"),
      )
    } finally {
      if (before === undefined) delete process.env["FAKE_TOKEN"]
      else process.env["FAKE_TOKEN"] = before
    }
  })

  it("ends the plugin's process with a sign-in given up; the next call starts a fresh one", async () => {
    const result = await withFake((provider) =>
      Effect.gen(function* () {
        const shown = yield* Stream.runCollect(Stream.take(signIn(provider, "device", {}), 1))
        const first = started()[0] ?? 0
        const afterwards = yield* failure(provider.env)
        return { shown, first, afterwards: afterwards.kind }
      }),
    )
    expect(result.shown.map((event) => event._tag)).toEqual(["ShowCode"])
    expect(started()).toHaveLength(2)
    expect(isRunning(result.first)).toBe(false)
    expect(result.afterwards).toBe("notSignedIn")
  })

  // What the engine relies on to find a block's login again (runbooks-reviewer's
  // review of rebuild/main, group 4): after the process is killed, the call
  // it was to answer fails, a fresh process has no login, and detecting from
  // the values `env` gave before signs it in again.
  it("finds its login again in the values env gave, after its process was killed", async () => {
    const result = await withFake((provider) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(signIn(provider, "token", { token: TOKEN }))
        const before = yield* provider.env
        const first = started()[0] ?? 0
        process.kill(first, "SIGKILL")
        while (isRunning(first)) yield* Effect.sleep(10)
        const onTheDead = yield* failure(provider.env)
        const onTheFresh = yield* failure(provider.env)
        const values = Object.fromEntries(
          before.values.map(({ name, value, sensitive }) => [name, { value, secret: sensitive }]),
        )
        const found = yield* provider.detect([{ kind: "values", values, from: "cloud" }], NONE)
        const after = yield* provider.env
        const token = (env: typeof before) =>
          env.values.filter(({ value }) => Redacted.value(value) === TOKEN).length
        return {
          kinds: [onTheDead.kind, onTheFresh.kind],
          found: Option.map(found, ({ source }) => source),
          tokens: [token(before), token(after)],
        }
      }),
    )
    expect(result).toEqual({
      kinds: ["providerFailed", "notSignedIn"],
      found: Option.some("cloud"),
      tokens: [1, 1],
    })
    expect(started()).toHaveLength(2)
  })

  it("refuses a credentials file that others can read, or one outside the state folder", async () => {
    const errors = await Promise.all(
      (["fileReadableByOthers", "fileOutsideStateDir"] as const).map((fault) =>
        withFake(
          (provider) =>
            Effect.andThen(
              Stream.runDrain(signIn(provider, "token", { token: TOKEN })),
              failure(provider.env),
            ),
          { script: { ...FAKE_SCRIPT, faults: [fault] } },
        ),
      ),
    )
    expect(errors.map((error) => error.kind)).toEqual(["providerFailed", "providerFailed"])
    expect(errors[0]?.message).toContain("mode 644")
    expect(errors[1]?.message).toContain("outside its state folder")
  })
})
