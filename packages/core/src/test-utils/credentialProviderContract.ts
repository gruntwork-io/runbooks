/**
 * The contract every credential provider keeps, checked through the
 * engine's own `CredentialProviders`: for a plugin, that is the credential
 * client and the transport owner, so the suite sees what the engine sees.
 * It runs against the fake in memory (`../credential/fake.test.ts`), the
 * fake as a process, and a released binary named by environment variables
 * (`packages/platform-node/src/integration/credential/contract.test.ts`,
 * whose header says how to run it).
 *
 * The offline cases need no account and no network: each sign-in they
 * make is refused before it would reach one, or waits until it is given
 * up. The cases that need a real account are in a group of their own,
 * tagged `[account]` in its name; a subject without account scenarios
 * does not register it, so a job without credentials runs the rest.
 */
import { describe, expect, it } from "bun:test"
import { Effect, type Layer, Option, Redacted, Result, Schema, type Scope, Stream } from "effect"
import { type CredentialError, Requirement } from "@runbooks/blocks-core/contract"
import {
  type Constraints,
  type CredentialProvider,
  CredentialProviders,
  type ProviderConfig,
} from "../credential/provider.ts"
import { isOwnerOnly, prepareStateDir } from "../credential/stateDir.ts"
import { FileSystem, type FileSystemShape } from "../services/FileSystem.ts"

/** One sign-in: a method, what is typed into its fields, and the block's pins and requirements. */
export const ContractSignIn = Schema.Struct({
  method: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
  pins: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  requirements: Schema.optionalKey(Schema.Array(Requirement)),
})
export type ContractSignIn = typeof ContractSignIn.Type

/** What the suite signs in with, for one provider. */
export const ContractScenarios = Schema.Struct({
  /** Sign-ins the provider refuses with invalidParams, before it reaches any network. */
  invalidSignIns: Schema.Array(ContractSignIn),
  /** A sign-in that waits, for the person or a network that does not answer, until it is given up. */
  waitingSignIn: ContractSignIn,
  /** How long the waiting sign-in runs before it is given up: 1 s when absent. */
  giveUpAfterMillis: Schema.optionalKey(Schema.Int),
  /** The cases that need a real account. */
  account: Schema.optionalKey(
    Schema.Struct({
      /** A sign-in that succeeds. */
      signIn: ContractSignIn,
      /** One whose pins the login cannot reach. */
      pinMismatch: ContractSignIn,
      /** One whose requirements the login does not meet. */
      requirementNotMet: ContractSignIn,
      /** One whose login has expired: the sign-in or env answers expired. */
      expired: ContractSignIn,
      /** The names env returns that hold secrets: each must be marked sensitive. */
      secretNames: Schema.Array(Schema.String),
    }),
  ),
})
export type ContractScenarios = typeof ContractScenarios.Type

/** One provider for one case, and how to release what it used. */
export interface OpenedSubject {
  /** Opens providers, and holds the filesystem the state folder is on. */
  readonly layer: Layer.Layer<CredentialProviders | FileSystem>
  /** The provider's registry name. */
  readonly provider: string
  /** Its state folder need not exist: the suite makes it, as the engine does. */
  readonly config: ProviderConfig
  readonly release: () => Promise<void>
}

/**
 * What a case may reach: `offline` cases must not reach the network, and
 * a subject may give them a proxy that never answers; `account` cases sign
 * in to a real account.
 */
export type Reach = "offline" | "account"

export interface CredentialSubject {
  /** A fresh provider, with a state folder of its own, for each case. */
  readonly open: (reach: Reach) => Promise<OpenedSubject>
  readonly scenarios: ContractScenarios
}

/** A name a shell can set. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const constraintsOf = (signIn: ContractSignIn): Constraints => ({
  pins: signIn.pins ?? {},
  requirements: signIn.requirements ?? [],
})

const signInWith = (provider: CredentialProvider, signIn: ContractSignIn) =>
  provider.signIn(
    signIn.method,
    Object.fromEntries(
      Object.entries(signIn.fields).map(([name, value]) => [name, Redacted.make(value)]),
    ),
    constraintsOf(signIn),
  )

/** The kind of the error `effect` fails with, or "succeeded". */
const kindOf = <A>(effect: Effect.Effect<A, CredentialError>) =>
  Effect.map(Effect.result(effect), (result) =>
    Result.isSuccess(result) ? "succeeded" : result.failure.kind,
  )

const duplicatesOf = (names: ReadonlyArray<string>) =>
  names.filter((name, index) => names.indexOf(name) !== index)

export function credentialProviderContract(name: string, subject: CredentialSubject): void {
  const { scenarios } = subject
  const giveUpAfter = scenarios.giveUpAfterMillis ?? 1_000

  /** Runs `use` on a fresh provider, its state folder made owner-only first. */
  const withProvider = async <A>(
    reach: Reach,
    use: (
      provider: CredentialProvider,
      files: FileSystemShape,
      stateDir: string,
    ) => Effect.Effect<A, unknown, Scope.Scope>,
  ): Promise<A> => {
    const opened = await subject.open(reach)
    try {
      return await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* prepareStateDir(opened.config.stateDir)
            const providers = yield* CredentialProviders
            const provider = yield* providers.open(opened.provider, opened.config)
            return yield* use(provider, yield* FileSystem, opened.config.stateDir)
          }),
        ).pipe(Effect.provide(opened.layer)),
      )
    } finally {
      await opened.release()
    }
  }

  /** The secrets a sign-in types: what it puts in its method's secret fields. */
  const typedSecrets = (provider: CredentialProvider, signIn: ContractSignIn) =>
    Effect.map(provider.describe, (info) => {
      const method = info.methods.find((offered) => offered.name === signIn.method)
      return (method?.fields ?? []).flatMap((field) => {
        const value = signIn.fields[field.name]
        return field.secret && value !== undefined && value !== "" ? [value] : []
      })
    })

  describe(`credential provider contract: ${name}`, () => {
    it("describes itself consistently: unique names, a shell's env names, sources and levels once each", async () => {
      const info = await withProvider("offline", (provider) => provider.describe)
      expect(info.methods.length).toBeGreaterThan(0)
      expect(duplicatesOf(info.methods.map((method) => method.name))).toEqual([])
      for (const method of info.methods)
        expect([method.name, duplicatesOf(method.fields.map((field) => field.name))]).toEqual([
          method.name,
          [],
        ])
      expect(duplicatesOf(info.levels.map((level) => level.name))).toEqual([])
      expect(duplicatesOf(info.sources)).toEqual([])
      expect(info.names.length).toBeGreaterThan(0)
      expect(duplicatesOf(info.names)).toEqual([])
      expect(info.names.filter((envName) => !ENV_NAME.test(envName))).toEqual([])
    })

    it("answers notSignedIn to env, and to targets and select at a level chosen after sign-in, before any sign-in", async () => {
      const kinds = await withProvider("offline", (provider) =>
        Effect.gen(function* () {
          const info = yield* provider.describe
          const after = info.levels.filter((level) => level.chosen === "afterSignIn")
          return {
            env: yield* kindOf(provider.env),
            levels: yield* Effect.forEach(after, (level) =>
              Effect.all([
                kindOf(provider.targets(level.name, Option.none())),
                kindOf(provider.select({ [level.name]: "none-chosen" })),
              ]),
            ),
            count: after.length,
          }
        }),
      )
      expect(kinds.env).toBe("notSignedIn")
      expect(kinds.levels).toEqual(Array(kinds.count).fill(["notSignedIn", "notSignedIn"]))
    })

    it("refuses a method, field, pin level or requirement kind it does not have with invalidParams", async () => {
      const waiting = scenarios.waitingSignIn
      const kinds = await withProvider("offline", (provider) =>
        Effect.gen(function* () {
          const info = yield* provider.describe
          const unchecked = (["scopes", "roles"] as const).filter(
            (kind) => !info.requirements.includes(kind),
          )
          const tries: Array<ContractSignIn> = [
            { method: "no-such-method", fields: {} },
            { ...waiting, fields: { ...waiting.fields, noSuchField: "x" } },
            { ...waiting, pins: { noSuchLevel: "x" } },
            ...unchecked.map((kind): ContractSignIn => ({
              ...waiting,
              requirements: [
                kind === "scopes" ? { kind, scopes: ["x"] } : { kind, roles: [{ role: "x" }] },
              ],
            })),
          ]
          return yield* Effect.forEach(tries, (each) =>
            kindOf(Stream.runDrain(signInWith(provider, each))),
          )
        }),
      )
      expect(kinds.filter((kind) => kind !== "invalidParams")).toEqual([])
    })

    it("refuses each invalid sign-in with invalidParams", async () => {
      const kinds = await withProvider("offline", (provider) =>
        Effect.forEach(scenarios.invalidSignIns, (each) =>
          kindOf(Stream.runDrain(signInWith(provider, each))),
        ),
      )
      expect(kinds).toEqual(scenarios.invalidSignIns.map(() => "invalidParams"))
    })

    it("gives up a sign-in when asked, and answers the next call afresh", async () => {
      const result = await withProvider("offline", (provider) =>
        Effect.gen(function* () {
          yield* provider.describe
          const ended = yield* Stream.runDrain(signInWith(provider, scenarios.waitingSignIn)).pipe(
            Effect.result,
            Effect.timeoutOption(giveUpAfter),
          )
          return {
            stillWaiting: Option.isNone(ended),
            after: yield* kindOf(provider.env),
            described: yield* kindOf(provider.describe),
          }
        }),
      )
      expect(result).toEqual({ stillWaiting: true, after: "notSignedIn", described: "succeeded" })
    })
  })

  const account = scenarios.account
  if (account === undefined) return

  describe(`credential provider contract: ${name} [account]`, () => {
    it("signs in, and env gives declared names only, its secrets sensitive and its files owner-only in the state folder", async () => {
      const result = await withProvider("account", (provider, files, stateDir) =>
        Effect.gen(function* () {
          const info = yield* provider.describe
          const secrets = yield* typedSecrets(provider, account.signIn)
          const events = yield* Stream.runCollect(signInWith(provider, account.signIn))
          const env = yield* provider.env
          const filesOk = yield* Effect.forEach(
            env.values.filter((value) => value.file),
            (value) =>
              Effect.gen(function* () {
                const file = Redacted.value(value.value)
                const inside = yield* files.isContainedInReal(file, stateDir)
                const stat = yield* files.stat(file)
                return [value.name, inside, isOwnerOnly(stat.mode)] as const
              }),
          )
          return { info, secrets, events, env, filesOk }
        }),
      )
      expect(result.events.at(-1)?._tag).toBe("SignedIn")
      const names = result.env.values.map((value) => value.name)
      expect(names.filter((envName) => !result.info.names.includes(envName))).toEqual([])
      for (const value of result.env.values) {
        const isSecret =
          account.secretNames.includes(value.name) ||
          result.secrets.includes(Redacted.value(value.value))
        if (isSecret) expect([value.name, value.sensitive]).toEqual([value.name, true])
        expect(value.to.length).toBeGreaterThan(0)
      }
      expect(result.filesOk.filter(([, inside, owned]) => !(inside && owned))).toEqual([])
    })

    it("shows no secret typed into a sign-in in its prompts or its identity", async () => {
      const shown = await withProvider("account", (provider) =>
        Effect.gen(function* () {
          const secrets = yield* typedSecrets(provider, account.signIn)
          const events = yield* Stream.runCollect(signInWith(provider, account.signIn))
          const text = JSON.stringify(events)
          return secrets.filter((secret) => text.includes(secret)).length
        }),
      )
      expect(shown).toBe(0)
    })

    it("signs out, deleting every file it wrote, and env answers notSignedIn", async () => {
      const result = await withProvider("account", (provider, files, stateDir) =>
        Effect.gen(function* () {
          yield* Stream.runDrain(signInWith(provider, account.signIn))
          yield* provider.env
          yield* provider.signOut
          return { left: yield* files.readdir(stateDir), env: yield* kindOf(provider.env) }
        }),
      )
      expect(result).toEqual({ left: [], env: "notSignedIn" })
    })

    it("answers pinMismatch for a pin the login cannot reach", async () => {
      const kind = await withProvider("account", (provider) =>
        kindOf(Stream.runDrain(signInWith(provider, account.pinMismatch))),
      )
      expect(kind).toBe("pinMismatch")
    })

    it("answers requirementNotMet, saying what is unmet", async () => {
      const error = await withProvider("account", (provider) =>
        Effect.flip(Stream.runDrain(signInWith(provider, account.requirementNotMet))),
      )
      expect(error.kind).toBe("requirementNotMet")
      expect(error.unmet?.length ?? 0).toBeGreaterThan(0)
    })

    it("answers expired for an expired login, at sign-in or at env", async () => {
      const kind = await withProvider("account", (provider) =>
        Effect.gen(function* () {
          const signedIn = yield* kindOf(Stream.runDrain(signInWith(provider, account.expired)))
          return signedIn === "succeeded" ? yield* kindOf(provider.env) : signedIn
        }),
      )
      expect(kind).toBe("expired")
    })
  })
}

/** What the suite signs in with against `FAKE_SCRIPT`, account cases included: the fake's logins are its accounts. */
export const FAKE_SCENARIOS: ContractScenarios = {
  invalidSignIns: [
    { method: "token", fields: {} },
    { method: "device", fields: { region: "west" } },
  ],
  waitingSignIn: { method: "device", fields: {} },
  account: {
    signIn: {
      method: "token",
      fields: { token: "fake-token-0001-secret" },
      pins: { account: "111111111111" },
    },
    pinMismatch: {
      method: "token",
      fields: { token: "fake-token-0001-secret" },
      pins: { account: "999999999999" },
    },
    requirementNotMet: {
      method: "token",
      fields: { token: "fake-token-0001-secret" },
      requirements: [{ kind: "scopes", scopes: ["admin"] }],
    },
    expired: { method: "token", fields: { token: "fake-expired-token-0001" } },
    secretNames: ["FAKE_TOKEN"],
  },
}
