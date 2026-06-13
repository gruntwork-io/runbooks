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
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const validate = (token: string, host?: string) =>
  Effect.gen(function* () {
    const client = yield* GitLabClient
    return yield* client.validateToken(token, host)
  }).pipe(Effect.provide(GitLabHttpClientLive))

describe("GitLabHttpClient.validateToken", () => {
  it("validates Bearer-FIRST in a single round trip and reads PAT scopes from /personal_access_tokens/self", async () => {
    let userAuth: string | null = null
    let userPrivateToken: string | null = null
    let patSelfAuth: string | null = null
    let userCalls = 0
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith("/api/v4/user")) {
        userCalls++
        userAuth = headers.get("Authorization")
        userPrivateToken = headers.get("PRIVATE-TOKEN")
        return json({
          username: "tanuki",
          name: "Tanuki Example",
          avatar_url: "https://gitlab.com/avatar.png",
          email: "tanuki@example.com",
        })
      }
      if (url.endsWith("/api/v4/personal_access_tokens/self")) {
        patSelfAuth = headers.get("Authorization")
        return json({ scopes: ["api", "write_repository"] })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("glpat-abc"))

    // Bearer-first (§3.3): one round trip, no PRIVATE-TOKEN attempt.
    expect(userAuth!).toBe("Bearer glpat-abc")
    expect(userPrivateToken).toBeNull()
    expect(userCalls).toBe(1)
    // PAT introspection authenticates with the scheme that validated (Bearer).
    expect(patSelfAuth!).toBe("Bearer glpat-abc")
    expect(result.user).toEqual({
      login: "tanuki",
      name: "Tanuki Example",
      avatarUrl: "https://gitlab.com/avatar.png",
      email: "tanuki@example.com",
    })
    expect(result.scopes).toEqual(["api", "write_repository"])
  })

  it("validates OAuth-shaped tokens on the first round trip (Bearer) and reads scopes from /oauth/token/info", async () => {
    // PRIVATE-TOKEN rejects OAuth tokens; Bearer-first means they never see a 401.
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
    expect(infoAuth!).toBe("Bearer oauth-token-xyz")
    // Bearer-first: /user succeeds on the single Bearer attempt.
    expect(calls.filter((u) => u.endsWith("/api/v4/user"))).toHaveLength(1)
  })

  it("falls back to /personal_access_tokens/self for a custom-prefix PAT (admin-configured, non-glpat)", async () => {
    // Self-managed instances can set a custom PAT prefix: the token validates
    // via Bearer but is NOT an OAuth token, so /oauth/token/info 401s — scope
    // introspection must fall back to the PAT endpoint, keeping the
    // write_repository warning armed for read-only tokens.
    const calls: string[] = []
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      calls.push(url)
      if (url.endsWith("/api/v4/user")) {
        return json({ username: "corp-user" })
      }
      if (url.endsWith("/oauth/token/info")) {
        return new Response("401 Unauthorized", { status: 401 })
      }
      if (url.endsWith("/api/v4/personal_access_tokens/self")) {
        expect(headers.get("Authorization")).toBe("Bearer corp-prefix-abc123")
        return json({ scopes: ["read_api"] })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("corp-prefix-abc123"))

    expect(result.user.login).toBe("corp-user")
    expect(result.scopes).toEqual(["read_api"])
    expect(calls.some((u) => u.endsWith("/api/v4/personal_access_tokens/self"))).toBe(true)
  })

  it("retries once with PRIVATE-TOKEN on 401 for old self-hosted instances", async () => {
    let userCalls = 0
    let patSelfPrivateToken: string | null = null
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith("/api/v4/user")) {
        userCalls++
        // This old instance only understands PRIVATE-TOKEN.
        if (headers.get("PRIVATE-TOKEN") === "glpat-old") return json({ username: "legacy" })
        return new Response("401 Unauthorized", { status: 401 })
      }
      if (url.endsWith("/api/v4/personal_access_tokens/self")) {
        patSelfPrivateToken = headers.get("PRIVATE-TOKEN")
        return json({ scopes: ["api"] })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("glpat-old"))

    expect(result.user.login).toBe("legacy")
    expect(userCalls).toBe(2) // Bearer, then the PRIVATE-TOKEN retry
    // Introspection authenticates with the scheme that validated (private).
    expect(patSelfPrivateToken!).toBe("glpat-old")
  })

  it("does not retry with PRIVATE-TOKEN on 403 (insufficient scope, not a wrong scheme)", async () => {
    // A 403 means the token authenticated but lacks scope to read /user; retrying
    // with another scheme (same token/scopes) can't help, so it must fail fast.
    let privateAttempted = false
    mockFetch((url, init) => {
      const headers = new Headers(init?.headers)
      if (headers.get("PRIVATE-TOKEN") !== null) privateAttempted = true
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
    expect(privateAttempted).toBe(false)
  })

  it("classifies a transport trust failure as kind 'tls' with status 0 — never an auth failure", async () => {
    // The undici global-fetch rejection shape: TypeError("fetch failed") with
    // the OpenSSL code on .cause.
    const cause = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    })
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed", { cause }))) as unknown as typeof fetch

    const result = await Effect.runPromise(Effect.either(validate("glpat-abc")))

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(GitLabApiError)
      expect(result.left.status).toBe(0)
      expect(result.left.kind).toBe("tls")
    }
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

  it("targets a self-managed host's API when one is given", async () => {
    const urls: string[] = []
    mockFetch((url) => {
      urls.push(url)
      if (url.endsWith("/api/v4/user")) return json({ username: "root" })
      if (url.endsWith("/personal_access_tokens/self")) return json({ scopes: ["api"] })
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("glpat-self", "gitlab.gruntwork.io"))

    expect(result.user.login).toBe("root")
    // Every request must hit the self-managed instance, not gitlab.com.
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith("https://gitlab.gruntwork.io/"))).toBe(true)
    expect(urls).toContain("https://gitlab.gruntwork.io/api/v4/user")
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
    expect(requestedUrl!).toBe(
      "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject/merge_requests",
    )
    expect(sentBody!).toEqual({
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

    expect(sentBody!).toEqual({ source_branch: "b", target_branch: "main", title: "t" })
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

    expect(requestedUrl!).toContain("/api/v4/projects/group%2Fsub%2Fproj/labels")
    expect(requestedUrl!).toContain("include_ancestor_groups=true")
    expect(labels).toEqual(["bug", "enhancement"])
  })
})

describe("GitLabHttpClient — self-hosted base URL", () => {
  const SELF_HOSTED = "https://gitlab.example.com"

  it("validateToken targets the supplied instance's /api/v4, not gitlab.com", async () => {
    const urls: string[] = []
    mockFetch((url) => {
      urls.push(url)
      if (url.endsWith("/api/v4/user")) {
        return json({ username: "tanuki" })
      }
      if (url.endsWith("/api/v4/personal_access_tokens/self")) {
        return json({ scopes: ["api"] })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(validate("glpat-abc", SELF_HOSTED))

    expect(result.user.login).toBe("tanuki")
    expect(urls).toContain("https://gitlab.example.com/api/v4/user")
    expect(urls.every((u) => u.startsWith("https://gitlab.example.com/"))).toBe(true)
  })

  it("createMergeRequest posts to the instance from params.baseUrl", async () => {
    let requestedUrl: string | null = null
    mockFetch((url) => {
      requestedUrl = url
      return json({ iid: 7, web_url: `${SELF_HOSTED}/g/p/-/merge_requests/7`, source_branch: "b" })
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitLabClient
        return yield* client.createMergeRequest("glpat-abc", {
          owner: "g",
          repo: "p",
          title: "t",
          baseBranch: "main",
          headBranch: "b",
          baseUrl: SELF_HOSTED,
        })
      }).pipe(Effect.provide(GitLabHttpClientLive)),
    )

    expect(requestedUrl!).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests")
    expect(result.url).toBe("https://gitlab.example.com/g/p/-/merge_requests/7")
  })

  it("listLabels reads from the instance's API base", async () => {
    let requestedUrl: string | null = null
    mockFetch((url) => {
      requestedUrl = url
      return json([{ name: "bug" }])
    })

    const labels = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitLabClient
        return yield* client.listLabels("glpat-abc", "g", "p", SELF_HOSTED)
      }).pipe(Effect.provide(GitLabHttpClientLive)),
    )

    expect(requestedUrl!).toContain("https://gitlab.example.com/api/v4/projects/g%2Fp/labels")
    expect(labels).toEqual(["bug"])
  })

  it("defaults to gitlab.com when no base URL is given", async () => {
    const urls: string[] = []
    mockFetch((url) => {
      urls.push(url)
      if (url.endsWith("/api/v4/user")) return json({ username: "tanuki" })
      return json({ scopes: [] })
    })

    await Effect.runPromise(validate("glpat-abc"))

    expect(urls).toContain("https://gitlab.com/api/v4/user")
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
