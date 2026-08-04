import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_CREDENTIALS_ENV,
  GOOGLE_OAUTH_CLIENT_ID_ENV,
  GOOGLE_OAUTH_CLIENT_SECRET_ENV,
  expandHomePath,
  isOAuthClientConfigured,
  parseOAuthClientCredentialsJson,
  resolveOAuthClient,
} from "./oauth-client.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"

const INSTALLED_JSON = JSON.stringify({
  installed: {
    client_id: "123.apps.googleusercontent.com",
    client_secret: "GOCSPX-desktop-secret",
    redirect_uris: ["http://localhost"],
  },
})

const WEB_JSON = JSON.stringify({
  web: {
    client_id: "web.apps.googleusercontent.com",
    client_secret: "GOCSPX-web-secret",
  },
})

const CLIENT_FILE = "/home/dev/.config/gcloud/client_secret_terrazone_a.json"

const provideResolve = (
  effect: Effect.Effect<unknown, unknown, unknown>,
  env: Record<string, string>,
  files: Record<string, string> = {},
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(makeTestEnvironment(env), makeTestFileSystem(files))),
    ) as Effect.Effect<unknown, unknown, never>,
  )

describe("expandHomePath", () => {
  it("expands ~/ against HOME", () => {
    expect(expandHomePath("~/.config/gcloud/client.json", "/home/dev")).toBe(
      "/home/dev/.config/gcloud/client.json",
    )
  })

  it("expands bare ~", () => {
    expect(expandHomePath("~", "/home/dev")).toBe("/home/dev")
  })

  it("leaves absolute paths unchanged", () => {
    expect(expandHomePath("/tmp/client.json", "/home/dev")).toBe("/tmp/client.json")
  })

  it("trims whitespace", () => {
    expect(expandHomePath("  /tmp/client.json  ", "/home/dev")).toBe("/tmp/client.json")
  })
})

describe("parseOAuthClientCredentialsJson", () => {
  it("parses the Desktop installed shape", () => {
    const result = parseOAuthClientCredentialsJson(INSTALLED_JSON)
    expect(result).toEqual({
      ok: true,
      value: {
        clientId: "123.apps.googleusercontent.com",
        clientSecret: "GOCSPX-desktop-secret",
      },
    })
  })

  it("rejects a Web client JSON", () => {
    const result = parseOAuthClientCredentialsJson(WEB_JSON)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Web client/)
    }
  })

  it("rejects JSON missing installed", () => {
    const result = parseOAuthClientCredentialsJson('{"type":"service_account"}')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/installed/)
    }
  })

  it("rejects invalid JSON", () => {
    const result = parseOAuthClientCredentialsJson("{not-json")
    expect(result.ok).toBe(false)
  })

  it("rejects installed without client_secret", () => {
    const result = parseOAuthClientCredentialsJson(
      JSON.stringify({ installed: { client_id: "only-id.apps.googleusercontent.com" } }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/client_secret/)
    }
  })
})

describe("resolveOAuthClient", () => {
  it("prefers author id/secret props", async () => {
    const result = await provideResolve(
      resolveOAuthClient({
        clientId: "prop.apps.googleusercontent.com",
        clientSecret: "prop-secret",
      }),
      {
        [GOOGLE_OAUTH_CLIENT_ID_ENV]: "env.apps.googleusercontent.com",
        [GOOGLE_OAUTH_CLIENT_SECRET_ENV]: "env-secret",
      },
      { [CLIENT_FILE]: INSTALLED_JSON },
    )

    expect(result).toEqual({
      clientId: "prop.apps.googleusercontent.com",
      clientSecret: "prop-secret",
      source: "props",
    })
  })

  it("refuses author id without secret", async () => {
    const error = await Effect.runPromise(
      resolveOAuthClient({ clientId: "prop.apps.googleusercontent.com" }).pipe(
        Effect.flip,
        Effect.provide(Layer.merge(makeTestEnvironment({}), makeTestFileSystem({}))),
      ),
    )

    expect(error._tag).toBe("GoogleOAuthError")
    expect(error.message).toMatch(/without oauthClientSecret/)
  })

  it("loads an author oauthClientFile with ~ expansion", async () => {
    const result = await provideResolve(
      resolveOAuthClient({ clientFile: "~/.config/gcloud/client_secret_terrazone_a.json" }),
      { HOME: "/home/dev" },
      { [CLIENT_FILE]: INSTALLED_JSON },
    )

    expect(result).toEqual({
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-desktop-secret",
      source: "file",
    })
  })

  it("rejects mixing oauthClientFile with id/secret props", async () => {
    const error = await Effect.runPromise(
      resolveOAuthClient({
        clientFile: CLIENT_FILE,
        clientId: "prop.apps.googleusercontent.com",
        clientSecret: "prop-secret",
      }).pipe(
        Effect.flip,
        Effect.provide(Layer.merge(makeTestEnvironment({}), makeTestFileSystem({}))),
      ),
    )

    expect(error._tag).toBe("GoogleOAuthError")
    expect(error.message).toMatch(/not both/)
  })

  it("loads GOOGLE_OAUTH_CLIENT_CREDENTIALS when no author props are set", async () => {
    const result = await provideResolve(
      resolveOAuthClient(),
      {
        HOME: "/home/dev",
        [GOOGLE_OAUTH_CLIENT_CREDENTIALS_ENV]: CLIENT_FILE,
      },
      { [CLIENT_FILE]: INSTALLED_JSON },
    )

    expect(result).toEqual({
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-desktop-secret",
      source: "env-file",
    })
  })

  it("loads GOOGLE_OAUTH_CLIENT_ID/SECRET when no file env is set", async () => {
    const result = await provideResolve(
      resolveOAuthClient(),
      {
        [GOOGLE_OAUTH_CLIENT_ID_ENV]: "env.apps.googleusercontent.com",
        [GOOGLE_OAUTH_CLIENT_SECRET_ENV]: "env-secret",
      },
    )

    expect(result).toEqual({
      clientId: "env.apps.googleusercontent.com",
      clientSecret: "env-secret",
      source: "env",
    })
  })

  it("prefers the credentials-file env over id/secret env", async () => {
    const result = await provideResolve(
      resolveOAuthClient(),
      {
        HOME: "/home/dev",
        [GOOGLE_OAUTH_CLIENT_CREDENTIALS_ENV]: CLIENT_FILE,
        [GOOGLE_OAUTH_CLIENT_ID_ENV]: "env.apps.googleusercontent.com",
        [GOOGLE_OAUTH_CLIENT_SECRET_ENV]: "env-secret",
      },
      { [CLIENT_FILE]: INSTALLED_JSON },
    )

    expect(result).toEqual({
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-desktop-secret",
      source: "env-file",
    })
  })

  it("fails clearly when nothing is configured", async () => {
    // Build defaults are empty until TODO(release) ships a Gruntwork client.
    expect(DEFAULT_GOOGLE_OAUTH_CLIENT_ID).toBe("")

    const error = await Effect.runPromise(
      resolveOAuthClient().pipe(
        Effect.flip,
        Effect.provide(Layer.merge(makeTestEnvironment({}), makeTestFileSystem({}))),
      ),
    )

    expect(error._tag).toBe("GoogleOAuthError")
    expect(error.message).toBe("OAuth login is not configured for this build")
  })

  it("surfaces a missing client file as an OAuth error", async () => {
    const error = await Effect.runPromise(
      resolveOAuthClient({ clientFile: CLIENT_FILE }).pipe(
        Effect.flip,
        Effect.provide(
          Layer.merge(makeTestEnvironment({ HOME: "/home/dev" }), makeTestFileSystem({})),
        ),
      ),
    )

    expect(error._tag).toBe("GoogleOAuthError")
    expect(error.message).toMatch(/Failed to read OAuth client credentials file/)
  })
})

describe("isOAuthClientConfigured", () => {
  it("is true when operator env supplies a client", async () => {
    const available = await provideResolve(
      isOAuthClientConfigured(),
      {
        [GOOGLE_OAUTH_CLIENT_ID_ENV]: "env.apps.googleusercontent.com",
        [GOOGLE_OAUTH_CLIENT_SECRET_ENV]: "env-secret",
      },
    )
    expect(available).toBe(true)
  })

  it("is false when nothing resolves", async () => {
    const available = await provideResolve(isOAuthClientConfigured(), {})
    expect(available).toBe(false)
  })
})
