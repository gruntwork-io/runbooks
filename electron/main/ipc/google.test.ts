/**
 * GoogleAuth's exports against a runbook switch mid-sign-in, the region/zone
 * a sign-in exports against the ones it returns, and the google:check-project
 * reply the success card shows.
 *
 * Runs the real session manager, credential registry and credential-file
 * custody; only `electron` is replaced, plus the Google SDK boundary where a
 * handler calls it. A sign-in that finishes after a different runbook opened
 * must leave that runbook's exports and credential registry exactly as they
 * were, even when both runbooks have a `<GoogleAuth>` block with the same id.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import { Effect } from "effect"
import type {
  GoogleClient,
  GoogleClientShape,
  GoogleIdentity,
} from "../../../src/services/GoogleClient.ts"
import { GoogleAuthError } from "../../../src/errors/index.ts"
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
const { runtime, sessionManager } = await import("./runtime.ts")
const { activeCredentialFor, resetGoogleCredentialRegistry, setActiveCredential } =
  await import("./google-credential-registry.ts")
const { cleanupGoogleCredentialFiles } = await import("./google-credentials.ts")
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")
const { makeTestGoogleClient } = await import("../../../src/test-utils/TestLayer.ts")

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

/** The variables block `blockId`'s export sets, or none when it has no export. */
const exported = (blockId = "gcp") => sessionManager.getEnvExport(blockId)?.env ?? {}

const credentialDirs = () =>
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("runbooks-gcp-"))

/**
 * Open `name` from inside the next export, before it lands: the user
 * switching runbooks while a sign-in is saving its credential.
 */
const openRunbookDuringNextExport = (name: string, alsoInNewRunbook?: () => void) => {
  const original = sessionManager.setEnvExport.bind(sessionManager)
  const spy = spyOn(sessionManager, "setEnvExport").mockImplementationOnce(
    (blockId, envExport, generation) =>
      openRunbookEffect(name).pipe(
        Effect.tap(() => Effect.sync(() => alsoInNewRunbook?.())),
        Effect.flatMap(() => original(blockId, envExport, generation)),
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

    expect(sessionManager.getEnvExport("gcp")).toBeUndefined()
    expect(activeCredentialFor("gcp")).toBeUndefined()
    // Nothing materialised: the key never reached disk for a runbook that is gone.
    expect(credentialDirs()).toEqual(dirsBefore)
  })

  it("runbook switched while the credential was being saved: no export, no registry entry", async () => {
    const a = sessionManager.getGeneration()
    const spy = openRunbookDuringNextExport("runbook-b")

    await expect(
      registerAuthenticatedCredential(
        { blockId: "gcp", identity: SA, accessToken: "ya29.from-a" },
        a,
      ),
    ).rejects.toThrow(/different runbook was opened/)
    spy.mockRestore()

    expect(sessionManager.getEnvExport("gcp")).toBeUndefined()
    expect(activeCredentialFor("gcp")).toBeUndefined()
  })

  it("same runbook: the credential is exported and registered", async () => {
    const success = await registerAuthenticatedCredential(
      { blockId: "gcp", identity: SA, documentJson: SA_JSON },
      sessionManager.getGeneration(),
    )

    expect(exported()).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: success.credentialsPath!,
      CLOUDSDK_CORE_PROJECT: "a-proj",
    })
    expect(activeCredentialFor("gcp")?.principal).toBe(SA.email)
  })

  it("exports an access-token credential, clearing the credential file variables", async () => {
    await registerAuthenticatedCredential(
      { blockId: "gcp", identity: SA, accessToken: "ya29.from-a" },
      sessionManager.getGeneration(),
    )

    expect(exported()).toMatchObject({
      GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.from-a",
      CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29.from-a",
      CLOUDSDK_CORE_ACCOUNT: SA.email,
    })
    expect(sessionManager.getEnvExport("gcp")?.clears).toContain("GOOGLE_APPLICATION_CREDENTIALS")
    // Nothing goes in the env every script gets
    const session = await Effect.runPromise(sessionManager.getSession())
    expect(session.env.get("GOOGLE_OAUTH_ACCESS_TOKEN")).toBeUndefined()
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
    const spy = openRunbookDuringNextExport("runbook-b", () =>
      setActiveCredential("gcp", bCredential),
    )

    const result = await invoke("google:set-project", { blockId: "gcp", projectId: "a-proj" })
    spy.mockRestore()

    expect(result.ok).toBe(true)
    expect(activeCredentialFor("gcp")?.projectId).toBe("b-proj")
    expect(sessionManager.getEnvExport("gcp")).toBeUndefined()
  })

  it("a block with a registered credential: its export doesn't replace the new runbook's", async () => {
    // A's access-token block re-exports its credential with the new project,
    // scoped to A's generation.
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
    const bExport = {
      env: { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: bCredential.credentialsPath },
      clears: [],
    }
    const spy = openRunbookDuringNextExport("runbook-b", () => {
      setActiveCredential("gcp", bCredential)
      Effect.runSync(sessionManager.setEnvExport("gcp", bExport, sessionManager.getGeneration()))
    })

    const result = await invoke("google:set-project", { blockId: "gcp", projectId: "a-proj-2" })
    spy.mockRestore()

    expect(result.ok).toBe(true)
    expect(activeCredentialFor("gcp")?.projectId).toBe("b-proj")
    expect(sessionManager.getEnvExport("gcp")).toEqual(bExport)
  })
})

describe("the region/zone a sign-in exports is the one it returns", () => {
  const USER: GoogleIdentity = {
    email: "dev@example.com",
    accountType: "user",
    credentialType: "authorized_user",
  }
  const ADC_JSON = JSON.stringify({
    type: "authorized_user",
    client_id: "cid.apps.googleusercontent.com",
    client_secret: "csecret",
    refresh_token: "1//refresh",
  })
  const ADC_PATH = "/home/u/.config/gcloud/application_default_credentials.json"

  /** The Google SDK boundary; the session, registry and handlers are real. */
  let google: Partial<GoogleClientShape> = {}
  let runPromise: ReturnType<typeof spyOn<typeof runtime, "runPromise">>

  beforeEach(() => {
    google = {
      validateAccessToken: () => Effect.succeed(USER),
      validateAdcDocument: () => Effect.succeed(USER),
      // A user who can list no projects, so no set-project follows.
      listProjects: () => Effect.succeed([]),
      pollOAuthFlow: () =>
        Effect.succeed({
          status: "complete" as const,
          adcJson: ADC_JSON,
          accessToken: "ya29.fresh",
        }),
      listGcloudConfigurations: () =>
        Effect.succeed({
          configurations: [
            {
              name: "default",
              isActive: true,
              account: USER.email,
              project: "proj-a",
              region: "us-west1",
              zone: "us-west1-a",
              authType: "adc-user" as const,
            },
          ],
          activeConfiguration: "default",
          configRoot: "/home/u/.config/gcloud",
          adc: { path: ADC_PATH, type: "authorized_user" as const },
        }),
      readCredentialFileContents: () => Effect.succeed(ADC_JSON),
    }
    runPromise = spyOn(runtime, "runPromise").mockImplementation((<A, E>(
      effect: Effect.Effect<A, E, GoogleClient>,
    ) =>
      Effect.runPromise(
        Effect.provide(effect, makeTestGoogleClient(google)),
      )) as typeof runtime.runPromise)
  })

  afterEach(() => {
    runPromise.mockRestore()
  })

  it("google:oauth-poll exports the region/zone the block sent, and returns them", async () => {
    const result = await invoke("google:oauth-poll", {
      flowId: "flow-1",
      blockId: "gcp",
      region: "europe-west1",
      zone: "europe-west1-b",
    })

    expect(result).toMatchObject({
      status: "complete",
      region: "europe-west1",
      zone: "europe-west1-b",
    })
    expect(exported()).toMatchObject({
      GOOGLE_CLOUD_REGION: "europe-west1",
      CLOUDSDK_COMPUTE_ZONE: "europe-west1-b",
    })
    // A later "Change project" keeps them.
    expect(activeCredentialFor("gcp")).toMatchObject({
      region: "europe-west1",
      zone: "europe-west1-b",
    })
  })

  it("google:oauth-poll with no region/zone exports and returns none", async () => {
    const result = await invoke("google:oauth-poll", { flowId: "flow-2", blockId: "gcp" })

    expect(result.status).toBe("complete")
    expect(result.region).toBeUndefined()
    expect(result.zone).toBeUndefined()
    expect(exported().GOOGLE_CLOUD_REGION).toBeUndefined()
  })

  it("google:gcloud-auth returns the configuration's region/zone when the block sent none", async () => {
    const result = await invoke("google:gcloud-auth", { blockId: "gcp", configuration: "default" })

    expect(result).toMatchObject({ valid: true, region: "us-west1", zone: "us-west1-a" })
    expect(exported()).toMatchObject({
      GOOGLE_CLOUD_REGION: "us-west1",
      CLOUDSDK_COMPUTE_ZONE: "us-west1-a",
      CLOUDSDK_ACTIVE_CONFIG_NAME: "default",
    })
  })

  it("google:gcloud-auth returns the region/zone the block sent over the configuration's", async () => {
    const result = await invoke("google:gcloud-auth", {
      blockId: "gcp",
      configuration: "default",
      region: "europe-west1",
      zone: "europe-west1-b",
    })

    expect(result).toMatchObject({ valid: true, region: "europe-west1", zone: "europe-west1-b" })
    expect(exported()).toMatchObject({
      GOOGLE_CLOUD_REGION: "europe-west1",
      CLOUDSDK_COMPUTE_ZONE: "europe-west1-b",
    })
  })
})

describe("google:check-project", () => {
  // The aws:check-region analogue (see aws.test.ts). useGoogleAuth appends any
  // `warning` to the success card, so only a typed failure (the credential
  // cannot build a client) earns one; a defect or an interruption says nothing
  // about the project and fails open.
  const ACCESS_TOKEN = "ya29.check-project-SECRET"

  /** The Google SDK boundary; the handler, domain and registry are real. */
  let checkProject: GoogleClientShape["checkProject"]
  let runPromiseExit: ReturnType<typeof spyOn<typeof runtime, "runPromiseExit">>
  let consoleError: ReturnType<typeof spyOn<typeof console, "error">>

  beforeEach(() => {
    setActiveCredential("gcp", {
      ref: { kind: "access_token", accessToken: ACCESS_TOKEN },
      principal: SA.email,
      credentialType: "service_account",
      projectId: "a-proj",
    })
    const google = makeTestGoogleClient({
      checkProject: (projectId, creds) => checkProject(projectId, creds),
    })
    runPromiseExit = spyOn(runtime, "runPromiseExit").mockImplementation((<A, E>(
      effect: Effect.Effect<A, E, GoogleClient>,
    ) => Effect.runPromiseExit(Effect.provide(effect, google))) as typeof runtime.runPromiseExit)
    consoleError = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    runPromiseExit.mockRestore()
    consoleError.mockRestore()
  })

  const checkProjectReply = () =>
    invoke("google:check-project", { blockId: "gcp", projectId: "a-proj" })

  /**
   * Every console.error the handler's own logger wrote, rendered the way the
   * console shows it (String() would hide an object's fields).
   */
  const handlerErrors = () =>
    consoleError.mock.calls
      .filter((args) => args[0] === "[ipc:google]")
      .map((args) =>
        args
          .map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg, { depth: Infinity })))
          .join(" "),
      )

  it("warns when the credential cannot build a client", async () => {
    const message =
      "Failed to check project: Error: The incoming JSON object does not contain a client_email field"
    checkProject = () => Effect.fail(new GoogleAuthError({ message }))

    expect(await checkProjectReply()).toStrictEqual({ enabled: false, warning: message })
    expect(handlerErrors()).toEqual([])
  })

  it.each([
    ["a defect", () => Effect.die(new Error("boom"))],
    ["an interruption", () => Effect.interrupt],
  ])(
    "fails open, and logs without the credential, when the check ends in %s",
    async (_label, outcome) => {
      checkProject = outcome

      expect(await checkProjectReply()).toStrictEqual({ enabled: true })
      const logged = handlerErrors()
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain("Project access check crashed")
      expect(logged[0]).not.toContain(ACCESS_TOKEN)
    },
  )
})
