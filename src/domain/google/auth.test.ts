import { describe, it, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import {
  DEFAULT_GOOGLE_SCOPES,
  ENV_PREFIX_PATTERN,
  cancelOAuthFlow,
  checkProject,
  confirmEnvCredentials,
  detectEnvCredentials,
  listGcloudConfigurations,
  listProjects,
  pollOAuthFlow,
  readApplicationDefaultCredentials,
  readCredentialFile,
  readCredentialFileContents,
  startOAuthFlow,
  validateAccessToken,
  validateAdcDocument,
  validateServiceAccountKey,
} from "./auth.ts"
import type { AdcInfo, GoogleIdentity } from "../../services/GoogleClient.ts"
import { GoogleConfigError } from "../../errors/index.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestGoogleClient } from "../../test-utils/TestLayer.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SA_IDENTITY: GoogleIdentity = {
  email: "runbooks@my-project.iam.gserviceaccount.com",
  uniqueId: "1234567890",
  accountType: "service_account",
  credentialType: "service_account",
  projectId: "my-project",
}

const USER_IDENTITY: GoogleIdentity = {
  email: "dev@example.com",
  accountType: "user",
  credentialType: "authorized_user",
  projectId: "my-project",
}

const KEY_PATH = "/home/dev/.config/gcloud/key.json"
const KEY_JSON = '{"type":"service_account","client_email":"runbooks@my-project.iam.gserviceaccount.com"}'
const ADC_JSON = '{"type":"authorized_user","refresh_token":"1//refresh"}'

// ---------------------------------------------------------------------------
// Client wrappers
// ---------------------------------------------------------------------------

describe("client wrappers", () => {
  it("validateServiceAccountKey delegates to the client", async () => {
    let seen: { keyJson: string; projectId?: string } | undefined
    const layer = makeTestGoogleClient({
      validateServiceAccountKey: (keyJson, projectId) => {
        seen = { keyJson, projectId }
        return Effect.succeed(SA_IDENTITY)
      },
    })

    const result = await Effect.runPromise(
      validateServiceAccountKey(KEY_JSON, "override-project").pipe(Effect.provide(layer)),
    )

    expect(seen).toEqual({ keyJson: KEY_JSON, projectId: "override-project" })
    expect(result).toEqual(SA_IDENTITY)
  })

  it("validateAccessToken delegates to the client", async () => {
    let seen: { accessToken: string; projectId?: string } | undefined
    const layer = makeTestGoogleClient({
      validateAccessToken: (accessToken, projectId) => {
        seen = { accessToken, projectId }
        return Effect.succeed(USER_IDENTITY)
      },
    })

    const result = await Effect.runPromise(
      validateAccessToken("ya29.token").pipe(Effect.provide(layer)),
    )

    expect(seen).toEqual({ accessToken: "ya29.token", projectId: undefined })
    expect(result).toEqual(USER_IDENTITY)
  })

  it("validateAdcDocument delegates to the client", async () => {
    let seen: { adcJson: string; projectId?: string } | undefined
    const layer = makeTestGoogleClient({
      validateAdcDocument: (adcJson, projectId) => {
        seen = { adcJson, projectId }
        return Effect.succeed(USER_IDENTITY)
      },
    })

    const result = await Effect.runPromise(
      validateAdcDocument(ADC_JSON, "my-project").pipe(Effect.provide(layer)),
    )

    expect(seen).toEqual({ adcJson: ADC_JSON, projectId: "my-project" })
    expect(result).toEqual(USER_IDENTITY)
  })

  it("readCredentialFile delegates to the client", async () => {
    const adc: AdcInfo = {
      path: KEY_PATH,
      type: "service_account",
      clientEmail: SA_IDENTITY.email,
    }
    let seen: string | undefined
    const layer = makeTestGoogleClient({
      readCredentialFile: (filePath) => {
        seen = filePath
        return Effect.succeed(adc)
      },
    })

    const result = await Effect.runPromise(
      readCredentialFile(KEY_PATH).pipe(Effect.provide(layer)),
    )

    expect(seen).toBe(KEY_PATH)
    expect(result).toEqual(adc)
  })

  it("readCredentialFileContents delegates to the client", async () => {
    let seen: string | undefined
    const layer = makeTestGoogleClient({
      readCredentialFileContents: (filePath) => {
        seen = filePath
        return Effect.succeed(KEY_JSON)
      },
    })

    const result = await Effect.runPromise(
      readCredentialFileContents(KEY_PATH).pipe(Effect.provide(layer)),
    )

    expect(seen).toBe(KEY_PATH)
    expect(result).toBe(KEY_JSON)
  })

  it("listGcloudConfigurations delegates to the client", async () => {
    const listing = {
      configurations: [{ name: "default", isActive: true, authType: "adc-user" as const }],
      activeConfiguration: "default",
      configRoot: "/home/dev/.config/gcloud",
    }
    const layer = makeTestGoogleClient({
      listGcloudConfigurations: () => Effect.succeed(listing),
    })

    const result = await Effect.runPromise(
      listGcloudConfigurations().pipe(Effect.provide(layer)),
    )

    expect(result).toEqual(listing)
  })

  it("readApplicationDefaultCredentials delegates to the client", async () => {
    const layer = makeTestGoogleClient({
      readApplicationDefaultCredentials: () => Effect.succeed(undefined),
    })

    const result = await Effect.runPromise(
      readApplicationDefaultCredentials().pipe(Effect.provide(layer)),
    )

    expect(result).toBeUndefined()
  })

  it("pollOAuthFlow delegates to the client", async () => {
    let seen: string | undefined
    const layer = makeTestGoogleClient({
      pollOAuthFlow: (flowId) => {
        seen = flowId
        return Effect.succeed({ status: "pending" as const })
      },
    })

    const result = await Effect.runPromise(
      pollOAuthFlow("flow-1").pipe(Effect.provide(layer)),
    )

    expect(seen).toBe("flow-1")
    expect(result.status).toBe("pending")
  })

  it("cancelOAuthFlow delegates to the client", async () => {
    let seen: string | undefined
    const layer = makeTestGoogleClient({
      cancelOAuthFlow: (flowId) =>
        Effect.sync(() => {
          seen = flowId
        }),
    })

    await Effect.runPromise(cancelOAuthFlow("flow-1").pipe(Effect.provide(layer)))

    expect(seen).toBe("flow-1")
  })

  it("listProjects delegates to the client", async () => {
    const projects = [{ projectId: "my-project", displayName: "My Project" }]
    let seen: { query?: string; pageSize?: number } | undefined
    const layer = makeTestGoogleClient({
      listProjects: (_creds, query, pageSize) => {
        seen = { query, pageSize }
        return Effect.succeed(projects)
      },
    })

    const result = await Effect.runPromise(
      listProjects({ kind: "file", path: KEY_PATH }, "my", 50).pipe(Effect.provide(layer)),
    )

    expect(seen).toEqual({ query: "my", pageSize: 50 })
    expect(result).toEqual(projects)
  })

  it("checkProject delegates to the client and passes the verdict through", async () => {
    let seen: string | undefined
    const layer = makeTestGoogleClient({
      checkProject: (projectId, _creds) => {
        seen = projectId
        return Effect.succeed("denied" as const)
      },
    })

    const result = await Effect.runPromise(
      checkProject("my-project", { kind: "access_token", accessToken: "ya29.token" }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(seen).toBe("my-project")
    expect(result).toBe("denied")
  })

  it("checkProject reports an inconclusive answer as 'unknown', never 'denied'", async () => {
    // The AwsAuth analogue fails OPEN (AwsSdkClient.checkRegion: `catch: () => true`).
    // A disabled Resource Manager API or a network blip says nothing about the
    // project, and must not put "not accessible" on the success card.
    const layer = makeTestGoogleClient({
      checkProject: (_projectId, _creds) => Effect.succeed("unknown" as const),
    })

    const result = await Effect.runPromise(
      checkProject("my-project", { kind: "access_token", accessToken: "ya29.token" }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// OAuth start
// ---------------------------------------------------------------------------

describe("startOAuthFlow", () => {
  it("delegates to the client when a client id is configured", async () => {
    let seen: { clientId: string; clientSecret?: string; scopes: readonly string[] } | undefined
    const layer = makeTestGoogleClient({
      startOAuthFlow: (params) => {
        seen = {
          clientId: params.clientId,
          ...(params.clientSecret ? { clientSecret: params.clientSecret } : {}),
          scopes: params.scopes,
        }
        return Effect.succeed({
          flowId: "flow-1",
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth?...",
          redirectUri: "http://127.0.0.1:51234/oauth2callback",
          expiresInSeconds: 300,
        })
      },
    })

    const result = await Effect.runPromise(
      startOAuthFlow({
        clientId: "client-1",
        clientSecret: "secret-1",
        scopes: DEFAULT_GOOGLE_SCOPES,
      }).pipe(Effect.provide(layer)),
    )

    expect(seen).toEqual({
      clientId: "client-1",
      clientSecret: "secret-1",
      scopes: DEFAULT_GOOGLE_SCOPES,
    })
    expect(result.flowId).toBe("flow-1")
  })

  it("fails without opening a flow when no client id is configured", async () => {
    let started = false
    const layer = makeTestGoogleClient({
      startOAuthFlow: (_params) => {
        started = true
        return Effect.succeed({
          flowId: "flow-1",
          authUrl: "https://accounts.google.com",
          redirectUri: "http://127.0.0.1:51234/oauth2callback",
          expiresInSeconds: 300,
        })
      },
    })

    const error = await Effect.runPromise(
      startOAuthFlow({ clientId: "", scopes: DEFAULT_GOOGLE_SCOPES }).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    )

    expect(started).toBe(false)
    expect(error._tag).toBe("GoogleOAuthError")
    expect(error.message).toBe("OAuth login is not configured for this build")
  })

  it("refuses an author client id with no client secret", async () => {
    // The exchange might well succeed, but the authorized_user document minted
    // from it would carry client_secret:"" — which this codebase's own ADC
    // loader rejects — so every later refresh fails. Better a loud error than a
    // credential that only looks authenticated.
    let started = false
    const layer = makeTestGoogleClient({
      startOAuthFlow: (_params) => {
        started = true
        return Effect.succeed({
          flowId: "flow-1",
          authUrl: "https://accounts.google.com",
          redirectUri: "http://127.0.0.1:51234/oauth2callback",
          expiresInSeconds: 300,
        })
      },
    })

    const error = await Effect.runPromise(
      startOAuthFlow({
        clientId: "123.apps.googleusercontent.com",
        scopes: DEFAULT_GOOGLE_SCOPES,
      }).pipe(Effect.flip, Effect.provide(layer)),
    )

    expect(started).toBe(false)
    expect(error._tag).toBe("GoogleOAuthError")
    expect(error.message).toMatch(/without oauthClientSecret/)
  })
})

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

describe("detectEnvCredentials", () => {
  it("detects a credentials file path", async () => {
    const layer = makeTestEnvironment({ GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH })

    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(result).toBeDefined()
    expect(result!.credentialsPath).toBe(KEY_PATH)
    expect(result!.envVar).toBe("GOOGLE_APPLICATION_CREDENTIALS")
    expect(result!.credentialsJson).toBeUndefined()
    expect(result!.accessToken).toBeUndefined()
  })

  it("detects inline credentials JSON", async () => {
    const layer = makeTestEnvironment({ GOOGLE_CREDENTIALS: KEY_JSON })

    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(result!.credentialsJson).toBe(KEY_JSON)
    expect(result!.envVar).toBe("GOOGLE_CREDENTIALS")
    expect(result!.credentialsPath).toBeUndefined()
  })

  it("detects a bare access token", async () => {
    const layer = makeTestEnvironment({ CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29.cloudsdk" })

    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(result!.accessToken).toBe("ya29.cloudsdk")
    expect(result!.envVar).toBe("CLOUDSDK_AUTH_ACCESS_TOKEN")
  })

  it("prefers a file path, then inline JSON, then an access token", async () => {
    const all = {
      GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
      GOOGLE_CREDENTIALS: KEY_JSON,
      GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.oauth",
      CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29.cloudsdk",
    }

    const withPath = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(all))),
    )
    expect(withPath!.credentialsPath).toBe(KEY_PATH)

    const { GOOGLE_APPLICATION_CREDENTIALS: _path, ...withoutPath } = all
    const withJson = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(withoutPath))),
    )
    expect(withJson!.credentialsJson).toBe(KEY_JSON)

    const { GOOGLE_CREDENTIALS: _json, ...tokensOnly } = withoutPath
    const withToken = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(tokensOnly))),
    )
    expect(withToken!.accessToken).toBe("ya29.oauth")
    expect(withToken!.envVar).toBe("GOOGLE_OAUTH_ACCESS_TOKEN")
  })

  it("returns undefined when the environment is empty", async () => {
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment({}))),
    )

    expect(result).toBeUndefined()
  })

  it("returns undefined when only a project is set (a project is not a credential)", async () => {
    const layer = makeTestEnvironment({
      CLOUDSDK_CORE_PROJECT: "my-project",
      CLOUDSDK_COMPUTE_REGION: "us-central1",
    })

    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(result).toBeUndefined()
  })

  it("resolves the project in CLOUDSDK_CORE_PROJECT > GOOGLE_CLOUD_PROJECT > GOOGLE_PROJECT > GCLOUD_PROJECT order", async () => {
    const all = {
      GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
      CLOUDSDK_CORE_PROJECT: "cloudsdk-project",
      GOOGLE_CLOUD_PROJECT: "cloud-project",
      GOOGLE_PROJECT: "google-project",
      GCLOUD_PROJECT: "gcloud-project",
    }

    const first = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(all))),
    )
    expect(first!.projectId).toBe("cloudsdk-project")

    const { CLOUDSDK_CORE_PROJECT: _core, ...noCore } = all
    const second = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(noCore))),
    )
    expect(second!.projectId).toBe("cloud-project")

    const { GOOGLE_CLOUD_PROJECT: _cloud, ...noCloud } = noCore
    const third = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(noCloud))),
    )
    expect(third!.projectId).toBe("google-project")

    const { GOOGLE_PROJECT: _google, ...noGoogle } = noCloud
    const fourth = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(makeTestEnvironment(noGoogle))),
    )
    expect(fourth!.projectId).toBe("gcloud-project")
  })

  it("includes region and zone when set, and omits them when absent", async () => {
    const withGeo = await Effect.runPromise(
      detectEnvCredentials().pipe(
        Effect.provide(
          makeTestEnvironment({
            GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
            GOOGLE_CLOUD_REGION: "europe-west1",
            CLOUDSDK_COMPUTE_ZONE: "europe-west1-b",
          }),
        ),
      ),
    )
    expect(withGeo!.region).toBe("europe-west1")
    expect(withGeo!.zone).toBe("europe-west1-b")

    const withoutGeo = await Effect.runPromise(
      detectEnvCredentials().pipe(
        Effect.provide(makeTestEnvironment({ GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH })),
      ),
    )
    // Absent optional fields are absent, not present-and-undefined.
    expect("region" in withoutGeo!).toBe(false)
    expect("zone" in withoutGeo!).toBe(false)
    expect("projectId" in withoutGeo!).toBe(false)
  })

  it("prefers CLOUDSDK_COMPUTE_REGION over GOOGLE_CLOUD_REGION", async () => {
    const layer = makeTestEnvironment({
      GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
      CLOUDSDK_COMPUTE_REGION: "us-central1",
      GOOGLE_CLOUD_REGION: "europe-west1",
    })

    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(result!.region).toBe("us-central1")
  })

  it("reads prefixed variables and reports the prefixed name", async () => {
    const layer = makeTestEnvironment({
      RUNBOOKS_TEST_GOOGLE_CREDENTIALS: KEY_JSON,
      RUNBOOKS_TEST_CLOUDSDK_CORE_PROJECT: "prefixed-project",
      RUNBOOKS_TEST_CLOUDSDK_COMPUTE_ZONE: "us-central1-a",
    })

    const result = await Effect.runPromise(
      detectEnvCredentials("RUNBOOKS_TEST_").pipe(Effect.provide(layer)),
    )

    expect(result!.credentialsJson).toBe(KEY_JSON)
    expect(result!.envVar).toBe("RUNBOOKS_TEST_GOOGLE_CREDENTIALS")
    expect(result!.projectId).toBe("prefixed-project")
    expect(result!.zone).toBe("us-central1-a")
  })

  it("never falls back to unprefixed variables when a prefix is supplied", async () => {
    const layer = makeTestEnvironment({
      GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
      CLOUDSDK_CORE_PROJECT: "ambient-project",
    })

    const result = await Effect.runPromise(
      detectEnvCredentials("RUNBOOKS_TEST_").pipe(Effect.provide(layer)),
    )

    expect(result).toBeUndefined()
  })

  it("rejects a prefix that does not match ENV_PREFIX_PATTERN", async () => {
    const layer = makeTestEnvironment({
      "my-prefix-GOOGLE_APPLICATION_CREDENTIALS": KEY_PATH,
      GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
    })

    expect(ENV_PREFIX_PATTERN.test("my-prefix-")).toBe(false)

    const result = await Effect.runPromise(
      detectEnvCredentials("my-prefix-").pipe(Effect.provide(layer)),
    )

    expect(result).toBeUndefined()
  })

  it("treats an empty prefix as no prefix", async () => {
    const layer = makeTestEnvironment({ GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH })

    const result = await Effect.runPromise(
      detectEnvCredentials("").pipe(Effect.provide(layer)),
    )

    expect(result!.credentialsPath).toBe(KEY_PATH)
  })
})

// ---------------------------------------------------------------------------
// Environment confirmation
// ---------------------------------------------------------------------------

describe("confirmEnvCredentials", () => {
  it("fails with GoogleAuthError when no env credentials are found", async () => {
    const layer = Layer.merge(makeTestEnvironment({}), makeTestGoogleClient())

    const exit = await Effect.runPromiseExit(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(Exit.isFailure(exit)).toBe(true)

    const error = await Effect.runPromise(
      confirmEnvCredentials().pipe(Effect.flip, Effect.provide(layer)),
    )
    expect(error._tag).toBe("GoogleAuthError")
    expect(error.message).toBe("No Google Cloud credentials found in environment variables")
  })

  it("reads the credential file and validates it as a document", async () => {
    let readPath: string | undefined
    let validated: { adcJson: string; projectId?: string } | undefined
    const layer = Layer.merge(
      makeTestEnvironment({
        GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH,
        CLOUDSDK_CORE_PROJECT: "my-project",
      }),
      makeTestGoogleClient({
        readCredentialFileContents: (filePath) => {
          readPath = filePath
          return Effect.succeed(KEY_JSON)
        },
        validateAdcDocument: (adcJson, projectId) => {
          validated = { adcJson, projectId }
          return Effect.succeed(SA_IDENTITY)
        },
      }),
    )

    const result = await Effect.runPromise(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(readPath).toBe(KEY_PATH)
    expect(validated).toEqual({ adcJson: KEY_JSON, projectId: "my-project" })
    expect(result.identity).toEqual(SA_IDENTITY)
    expect(result.credentials.credentialsPath).toBe(KEY_PATH)
    expect(result.credentials.projectId).toBe("my-project")
  })

  it("validates inline JSON without touching the filesystem", async () => {
    let read = false
    const layer = Layer.merge(
      makeTestEnvironment({ GOOGLE_CREDENTIALS: ADC_JSON }),
      makeTestGoogleClient({
        readCredentialFileContents: (_filePath) => {
          read = true
          return Effect.succeed("")
        },
        validateAdcDocument: (_adcJson, _projectId) => Effect.succeed(USER_IDENTITY),
      }),
    )

    const result = await Effect.runPromise(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(read).toBe(false)
    expect(result.identity).toEqual(USER_IDENTITY)
    expect(result.credentials.credentialsJson).toBe(ADC_JSON)
  })

  it("validates a bare access token via tokeninfo", async () => {
    let seen: { accessToken: string; projectId?: string } | undefined
    const layer = Layer.merge(
      makeTestEnvironment({
        GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.oauth",
        GOOGLE_CLOUD_PROJECT: "my-project",
      }),
      makeTestGoogleClient({
        validateAccessToken: (accessToken, projectId) => {
          seen = { accessToken, projectId }
          return Effect.succeed({ ...USER_IDENTITY, credentialType: "access_token" as const })
        },
      }),
    )

    const result = await Effect.runPromise(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(seen).toEqual({ accessToken: "ya29.oauth", projectId: "my-project" })
    expect(result.identity.credentialType).toBe("access_token")
    expect(result.credentials.accessToken).toBe("ya29.oauth")
  })

  it("surfaces an unreadable credential file as a GoogleAuthError", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ GOOGLE_APPLICATION_CREDENTIALS: KEY_PATH }),
      makeTestGoogleClient({
        readCredentialFileContents: (_filePath) =>
          Effect.fail(new GoogleConfigError({ message: "Failed to read credentials file: ENOENT" })),
      }),
    )

    const error = await Effect.runPromise(
      confirmEnvCredentials().pipe(Effect.flip, Effect.provide(layer)),
    )

    expect(error._tag).toBe("GoogleAuthError")
    expect(error.message).toContain("ENOENT")
  })

  it("fails when the detected credential does not validate", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({ GOOGLE_CREDENTIALS: ADC_JSON }),
      makeTestGoogleClient(),
    )

    const exit = await Effect.runPromiseExit(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("honors the env prefix", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({
        GOOGLE_CREDENTIALS: KEY_JSON,
        RUNBOOKS_TEST_GOOGLE_CREDENTIALS: ADC_JSON,
      }),
      makeTestGoogleClient({
        validateAdcDocument: (_adcJson, _projectId) => Effect.succeed(USER_IDENTITY),
      }),
    )

    const result = await Effect.runPromise(
      confirmEnvCredentials("RUNBOOKS_TEST_").pipe(Effect.provide(layer)),
    )

    expect(result.credentials.credentialsJson).toBe(ADC_JSON)
    expect(result.credentials.envVar).toBe("RUNBOOKS_TEST_GOOGLE_CREDENTIALS")
  })
})
