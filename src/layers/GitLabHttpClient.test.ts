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

  it("does not retry with Bearer on 403 (insufficient scope, not a wrong scheme)", async () => {
    // A 403 means the token authenticated but lacks scope to read /user; retrying
    // with Bearer (same token/scopes) can't help, so it must fail fast.
    let bearerAttempted = false
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      if (headers.get("Authorization")?.startsWith("Bearer")) bearerAttempted = true
      if (url.endsWith("/api/v4/user")) {
        return new Response("403 Forbidden", { status: 403 })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(Effect.either(validate("glpat-scoped")))

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(GitLabApiError)
      expect(result.left.status).toBe(403)
    }
    expect(bearerAttempted).toBe(false)
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

describe("GitLabHttpClient.createMergeRequest", () => {
  const baseParams = {
    owner: "group/subgroup",
    repo: "project",
    title: "Add feature",
    body: "Description here",
    baseBranch: "main",
    headBranch: "runbook/123",
    labels: ["enhancement", "needs-review"],
  }

  const createMR = (token: string, params = baseParams) =>
    Effect.gen(function* () {
      const client = yield* GitLabClient
      return yield* client.createMergeRequest(token, params)
    }).pipe(Effect.provide(GitLabHttpClientLive))

  it("URL-encodes the nested project path, maps iid (not id), and sends labels as a comma string", async () => {
    let requestedUrl: string | null = null
    let sentBody: Record<string, unknown> | null = null
    mockFetch((url, init) => {
      requestedUrl = url
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({
        id: 9999, // global DB id — must NOT be surfaced
        iid: 42, // project-scoped, user-facing number
        web_url: "https://gitlab.com/group/subgroup/project/-/merge_requests/42",
        source_branch: "runbook/123",
      })
    })

    const result = await Effect.runPromise(createMR("glpat-abc"))

    // group/subgroup/project -> group%2Fsubgroup%2Fproject
    expect(requestedUrl).toBe(
      "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject/merge_requests",
    )
    expect(sentBody).toEqual({
      source_branch: "runbook/123",
      target_branch: "main",
      title: "Add feature",
      description: "Description here",
      labels: "enhancement,needs-review",
    })
    // iid, not id
    expect(result.number).toBe(42)
    expect(result.url).toBe("https://gitlab.com/group/subgroup/project/-/merge_requests/42")
    expect(result.branch).toBe("runbook/123")
  })

  it("omits description and labels when not provided", async () => {
    let sentBody: Record<string, unknown> | null = null
    mockFetch((_url, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({ iid: 1, web_url: "https://gitlab.com/x/y/-/merge_requests/1", source_branch: "b" })
    })

    await Effect.runPromise(
      createMR("glpat-abc", {
        owner: "x",
        repo: "y",
        title: "t",
        baseBranch: "main",
        headBranch: "b",
      } as typeof baseParams),
    )

    expect(sentBody).toEqual({ source_branch: "b", target_branch: "main", title: "t" })
  })

  it("fails with GitLabApiError carrying status 409 when an MR already exists", async () => {
    mockFetch(() => new Response("Cannot Create: This merge request already exists", { status: 409 }))

    const result = await Effect.runPromise(Effect.either(createMR("glpat-abc")))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(GitLabApiError)
      expect(result.left.status).toBe(409)
    }
  })
})

describe("GitLabHttpClient.listLabels", () => {
  const listLabels = (token: string, owner: string, repo: string) =>
    Effect.gen(function* () {
      const client = yield* GitLabClient
      return yield* client.listLabels(token, owner, repo)
    }).pipe(Effect.provide(GitLabHttpClientLive))

  it("encodes the project path, requests ancestor groups, and returns names", async () => {
    let requestedUrl: string | null = null
    mockFetch((url) => {
      requestedUrl = url
      return json([
        { name: "bug", color: "#ff0000" },
        { name: "enhancement", color: "#00ff00" },
      ])
    })

    const labels = await Effect.runPromise(listLabels("glpat-abc", "group/sub", "proj"))

    expect(requestedUrl).toContain("/api/v4/projects/group%2Fsub%2Fproj/labels")
    expect(requestedUrl).toContain("include_ancestor_groups=true")
    expect(labels).toEqual(["bug", "enhancement"])
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
