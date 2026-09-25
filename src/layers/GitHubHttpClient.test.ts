import { describe, it, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { GitHubHttpClientLive } from "./GitHubHttpClient.ts"
import { GitHubClient } from "../services/GitHubClient.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(impl: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const withClient = <A, E>(effect: Effect.Effect<A, E, GitHubClient>) =>
  effect.pipe(Effect.provide(GitHubHttpClientLive))

describe("GitHubHttpClient immutable IDs", () => {
  it("listOrgs maps numeric org IDs from the API", async () => {
    mockFetch((url) => {
      if (url.includes("/user/orgs")) {
        return json([{ id: 991, login: "acme-corp", description: "Acme" }])
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.listOrgs("ghp_test")
        }),
      ),
    )

    expect(result).toEqual([{ id: 991, login: "acme-corp", name: "Acme" }])
  })

  it("listRepos maps repo and owner numeric IDs", async () => {
    mockFetch((url) => {
      if (url.includes("/orgs/acme-corp") && !url.includes("/repos")) {
        return json({ login: "acme-corp" })
      }
      if (url.includes("/orgs/acme-corp/repos")) {
        return json([
          {
            id: 42,
            name: "infra",
            full_name: "acme-corp/infra",
            private: true,
            default_branch: "main",
            owner: { id: 991 },
          },
        ])
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.listRepos("ghp_test", "acme-corp")
        }),
      ),
    )

    expect(result).toEqual([
      {
        id: 42,
        ownerId: 991,
        name: "infra",
        fullName: "acme-corp/infra",
        private: true,
        defaultBranch: "main",
      },
    ])
  })

  it("getRepo returns immutable repo and owner IDs", async () => {
    mockFetch((url) => {
      if (url.includes("/repos/acme-corp/infra")) {
        return json({
          id: 42,
          name: "infra",
          full_name: "acme-corp/infra",
          private: false,
          default_branch: "main",
          owner: { id: 991 },
        })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.getRepo("ghp_test", "acme-corp", "infra")
        }),
      ),
    )

    expect(result).toEqual({
      id: 42,
      ownerId: 991,
      name: "infra",
      fullName: "acme-corp/infra",
      private: false,
      defaultBranch: "main",
    })
  })
})

describe("GitHubHttpClient OAuth device flow", () => {
  const startFlow = () =>
    Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.startOAuthDeviceFlow("client-id", ["repo"])
        }),
      ),
    )

  const poll = () =>
    Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.pollOAuthToken("client-id", "dev123")
        }),
      ),
    )

  const deviceCode = {
    device_code: "dev123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    interval: 5,
  }

  it("passes the device code's expires_in through", async () => {
    mockFetch(() => json({ ...deviceCode, expires_in: 600 }))

    expect(await startFlow()).toEqual({
      deviceCode: "dev123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 600,
    })
  })

  it("defaults expiresIn to GitHub's 15 minutes when expires_in is missing", async () => {
    mockFetch(() => json(deviceCode))

    expect((await startFlow()).expiresIn).toBe(900)
  })

  it("reports slow_down with GitHub's new interval instead of plain pending", async () => {
    mockFetch(() => json({ error: "slow_down", interval: 10 }))

    expect(await poll()).toEqual({ pending: true, slowDown: true, interval: 10 })
  })

  it("reports authorization_pending as plain pending", async () => {
    mockFetch(() => json({ error: "authorization_pending" }))

    expect(await poll()).toEqual({ pending: true })
  })
})
