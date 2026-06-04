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

const validate = (token: string) =>
  Effect.gen(function* () {
    const client = yield* GitLabClient
    return yield* client.validateToken(token)
  }).pipe(Effect.provide(GitLabHttpClientLive))

describe("GitLabHttpClient.validateToken", () => {
  it("maps username->login and avatar_url->avatarUrl", async () => {
    let seenUrl = ""
    let seenToken: string | null = null
    mockFetch((url, init) => {
      seenUrl = url
      seenToken = new Headers(init?.headers).get("PRIVATE-TOKEN")
      return new Response(
        JSON.stringify({
          username: "tanuki",
          name: "Tanuki Example",
          avatar_url: "https://gitlab.com/avatar.png",
          email: "tanuki@example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const result = await Effect.runPromise(validate("glpat-abc"))

    expect(seenUrl).toBe("https://gitlab.com/api/v4/user")
    expect(seenToken).toBe("glpat-abc")
    expect(result.user).toEqual({
      login: "tanuki",
      name: "Tanuki Example",
      avatarUrl: "https://gitlab.com/avatar.png",
      email: "tanuki@example.com",
    })
    // GitLab GET /user exposes no scope header.
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
