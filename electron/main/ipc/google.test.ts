/**
 * GoogleAuth's session writes against a runbook switch mid-sign-in.
 *
 * Runs the real session manager, credential registry and credential-file
 * custody; only `electron` is replaced. A sign-in that finishes after a
 * different runbook opened must leave that runbook's session env and
 * credential registry exactly as they were, even when both runbooks have a
 * `<GoogleAuth>` block with the same id.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import { Effect } from "effect"
import type { GoogleIdentity } from "../../../src/services/GoogleClient.ts"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()

mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerAuthenticatedCredential, registerGoogleHandlers } = await import("./google.ts")
const { sessionManager } = await import("./runtime.ts")
const { activeCredentialFor, resetGoogleCredentialRegistry, setActiveCredential } = await import(
  "./google-credential-registry.ts"
)
const { cleanupGoogleCredentialFiles } = await import("./google-credentials.ts")
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")

registerGoogleHandlers()

const invoke = (channel: string, params?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, params)) as Promise<any>
}

const SA: GoogleIdentity = {
  email: "sa@a-proj.iam.gserviceaccount.com",
  accountType: "service_account",
  credentialType: "service_account",
  projectId: "a-proj",
}

const SA_JSON = JSON.stringify({
  type: "service_account",
  client_email: SA.email,
  private_key: "-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n",
})

/** What runbook:get does when a different runbook is opened. */
const openRunbookEffect = (name: string) =>
  sessionManager.createSession(`/tmp/${name}`, `/tmp/${name}/runbook.mdx`).pipe(
    Effect.provide(makeTestEnvironment({})),
    Effect.tap(() => Effect.sync(resetGoogleCredentialRegistry)),
  )
const openRunbook = (name: string) => Effect.runPromise(openRunbookEffect(name))

const sessionEnv = async () => Object.fromEntries((await Effect.runPromise(sessionManager.getSession())).env)

const credentialDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("runbooks-gcp-"))

/**
 * Open `name` from inside the next session env write, before it lands: the
 * user switching runbooks while a sign-in is saving its credential.
 */
const openRunbookDuringNextEnvWrite = (name: string, alsoInNewRunbook?: () => void) => {
  const original = sessionManager.appendToEnv.bind(sessionManager)
  const spy = spyOn(sessionManager, "appendToEnv").mockImplementationOnce((env, generation) =>
    openRunbookEffect(name).pipe(
      Effect.tap(() => Effect.sync(() => alsoInNewRunbook?.())),
      Effect.flatMap(() => original(env, generation)),
    ),
  )
  return spy
}

beforeEach(async () => {
  await openRunbook("runbook-a")
})

afterEach(() => {
  resetGoogleCredentialRegistry()
  cleanupGoogleCredentialFiles()
  sessionManager.deleteSession()
})

describe("registerAuthenticatedCredential after another runbook opened", () => {
  it("validated in A, finished in B: refused before anything is written", async () => {
    const a = sessionManager.getGeneration()
    await openRunbook("runbook-b")
    const dirsBefore = credentialDirs()

    await expect(
      registerAuthenticatedCredential({ blockId: "gcp", identity: SA, documentJson: SA_JSON }, a),
    ).rejects.toThrow(/different runbook was opened/)

    const env = await sessionEnv()
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
    expect(env.CLOUDSDK_CORE_PROJECT).toBeUndefined()
    expect(activeCredentialFor("gcp")).toBeUndefined()
    // Nothing materialised: the key never reached disk for a runbook that is gone.
    expect(credentialDirs()).toEqual(dirsBefore)
  })

  it("runbook switched while the credential was being saved: no env, no registry entry", async () => {
    const a = sessionManager.getGeneration()
    const spy = openRunbookDuringNextEnvWrite("runbook-b")

    await expect(
      registerAuthenticatedCredential({ blockId: "gcp", identity: SA, accessToken: "ya29.from-a" }, a),
    ).rejects.toThrow(/different runbook was opened/)
    spy.mockRestore()

    const env = await sessionEnv()
    expect(env.CLOUDSDK_AUTH_ACCESS_TOKEN).toBeUndefined()
    expect(env.CLOUDSDK_CORE_ACCOUNT).toBeUndefined()
    expect(activeCredentialFor("gcp")).toBeUndefined()
  })

  it("same runbook: the credential is written and registered", async () => {
    const success = await registerAuthenticatedCredential(
      { blockId: "gcp", identity: SA, documentJson: SA_JSON },
      sessionManager.getGeneration(),
    )

    const env = await sessionEnv()
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(success.credentialsPath!)
    expect(env.CLOUDSDK_CORE_PROJECT).toBe("a-proj")
    expect(activeCredentialFor("gcp")?.principal).toBe(SA.email)
  })
})

describe("google:set-project after another runbook opened", () => {
  it("does not repoint the new runbook's same-id block", async () => {
    // Runbook B's own <GoogleAuth id="gcp"> signs in while A's project pick
    // is still saving.
    const bCredential = {
      ref: { kind: "access_token", accessToken: "ya29.from-b" } as const,
      principal: "b@b-proj.iam.gserviceaccount.com",
      credentialType: "service_account" as const,
      projectId: "b-proj",
    }
    const spy = openRunbookDuringNextEnvWrite("runbook-b", () => setActiveCredential("gcp", bCredential))

    const result = await invoke("google:set-project", { blockId: "gcp", projectId: "a-proj" })
    spy.mockRestore()

    expect(result.ok).toBe(true)
    expect(activeCredentialFor("gcp")?.projectId).toBe("b-proj")
    expect((await sessionEnv()).CLOUDSDK_CORE_PROJECT).toBeUndefined()
  })

  it("a block with a registered credential: neither its set nor its delete reaches the new runbook", async () => {
    // A's access-token block re-points the whole session (set) and drops the
    // gcloud file override (delete); both must be scoped to A's generation.
    await registerAuthenticatedCredential(
      { blockId: "gcp", identity: SA, accessToken: "ya29.from-a" },
      sessionManager.getGeneration(),
    )
    const bCredential = {
      ref: { kind: "file", path: "/tmp/runbook-b/adc.json" } as const,
      credentialsPath: "/tmp/runbook-b/adc.json",
      principal: "b@b-proj.iam.gserviceaccount.com",
      credentialType: "service_account" as const,
      projectId: "b-proj",
    }
    const spy = openRunbookDuringNextEnvWrite("runbook-b", () => {
      setActiveCredential("gcp", bCredential)
      Effect.runSync(
        sessionManager.appendToEnv({ CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: bCredential.credentialsPath }),
      )
    })

    const result = await invoke("google:set-project", { blockId: "gcp", projectId: "a-proj-2" })
    spy.mockRestore()

    expect(result.ok).toBe(true)
    expect(activeCredentialFor("gcp")?.projectId).toBe("b-proj")
    const env = await sessionEnv()
    expect(env.CLOUDSDK_CORE_PROJECT).toBeUndefined()
    expect(env.CLOUDSDK_AUTH_ACCESS_TOKEN).toBeUndefined()
    expect(env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).toBe(bCredential.credentialsPath)
  })
})
