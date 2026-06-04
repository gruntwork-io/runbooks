import { describe, it, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { GitLabHttpClientLive } from "./GitLabHttpClient.ts"
import { GitLabClient } from "../services/GitLabClient.ts"
import { GitLabApiError } from "../errors/index.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(impl: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const validate = (token: string) =>
  Effect.gen(function* () {
    const client = yield* GitLabClient
    return yield* client.validateToken(token)
  }).pipe(Effect.provide(GitLabHttpClientLive))

describe("GitLabHttpClient.validateToken", () => {
  it("maps username->login and reads PAT scopes from /personal_access_tokens/self", async () => {
    let userToken: string | null = null
    let patSelfToken: string | null = null
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith("/api/v4/user")) {
        userToken = headers.get("PRIVATE-TOKEN")
        return json({
          username: "tanuki",
          name: "Tanuki Example",
          avatar_url: "https://gitlab.com/avatar.png",
          email: "tanuki@example.com",
        })
      }
      if (url.endsWith("/api/v4/personal_access_tokens/self")) {
        patSelfToken = headers.get("PRIVATE-TOKEN")
        return json({ scopes: ["api", "write_repository"] })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("glpat-abc"))

    expect(userToken).toBe("glpat-abc")
    expect(patSelfToken).toBe("glpat-abc")
    expect(result.user).toEqual({
      login: "tanuki",
      name: "Tanuki Example",
      avatarUrl: "https://gitlab.com/avatar.png",
      email: "tanuki@example.com",
    })
    expect(result.scopes).toEqual(["api", "write_repository"])
  })

  it("falls back to Bearer for OAuth tokens and reads scopes from /oauth/token/info", async () => {
    // PRIVATE-TOKEN rejects OAuth tokens (401); Bearer accepts them.
    const calls: string[] = []
    let infoAuth: string | null = null
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      calls.push(url)
      if (url.endsWith("/api/v4/user")) {
        if (headers.get("PRIVATE-TOKEN") !== null) {
          return new Response("401 Unauthorized", { status: 401 })
        }
        return json({ username: "odgrim" })
      }
      if (url.endsWith("/oauth/token/info")) {
        infoAuth = headers.get("Authorization")
        return json({ scope: ["read_user", "write_repository", "api"] })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("oauth-token-xyz"))

    expect(result.user.login).toBe("odgrim")
    expect(result.scopes).toEqual(["read_user", "write_repository", "api"])
    expect(infoAuth).toBe("Bearer oauth-token-xyz")
    // /user is tried twice (PRIVATE-TOKEN, then Bearer), then introspection.
    expect(calls.filter((u) => u.endsWith("/api/v4/user"))).toHaveLength(2)
  })

  it("falls back to Bearer when PRIVATE-TOKEN returns 403", async () => {
    let bearerSeen: string | null = null
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith("/api/v4/user")) {
        if (headers.get("PRIVATE-TOKEN") !== null) {
          return new Response("403 Forbidden", { status: 403 })
        }
        bearerSeen = headers.get("Authorization")
        return json({ username: "odgrim" })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("oauth-token-xyz"))

    expect(result.user.login).toBe("odgrim")
    expect(bearerSeen).toBe("Bearer oauth-token-xyz")
    expect(result.scopes).toBeUndefined()
  })

  it("still validates when scope introspection is unavailable", async () => {
    // Introspection errors must never fail validation — scopes are enrichment.
    mockFetch((url) => {
      if (url.endsWith("/api/v4/user")) return json({ username: "tanuki" })
      return new Response("500 Internal Server Error", { status: 500 })
    })

    const result = await Effect.runPromise(validate("glpat-abc"))

    expect(result.user.login).toBe("tanuki")
    expect(result.scopes).toBeUndefined()
  })

  it("fails with GitLabApiError carrying the HTTP status", async () => {
    mockFetch(() => new Response("401 Unauthorized", { status: 401 }))

    const result = await Effect.runPromise(Effect.either(validate("glpat-bad")))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(GitLabApiError)
      expect(result.left.status).toBe(401)
      expect(result.left.message).toContain("401")
    }
  })
})

describe("GitLabHttpClient.detectTokenType", () => {
  it("classifies glpat- tokens as pat, others as unknown", async () => {
    const types = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitLabClient
        return {
          pat: client.detectTokenType("glpat-xyz"),
          unknown: client.detectTokenType("random"),
        }
      }).pipe(Effect.provide(GitLabHttpClientLive)),
    )
    expect(types.pat).toBe("pat")
    expect(types.unknown).toBe("unknown")
  })
})
