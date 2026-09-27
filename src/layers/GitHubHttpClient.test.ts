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

// ---------------------------------------------------------------------------
// Host routing (GitHub Enterprise Server / ghe.com)
// ---------------------------------------------------------------------------

describe("GitHubHttpClient host routing", () => {
  /** Record every fetch (URL, method, auth header) and answer with `respond`. */
  const recordFetch = (respond: (url: string) => Response = () => json({})) => {
    const calls: Array<{ url: string; method: string; authorization?: string }> = []
    mockFetch((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url, method: init?.method ?? "GET", authorization: headers.Authorization })
      return respond(url)
    })
    return calls
  }

  const run = <A, E>(f: (client: GitHubClient["Type"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(withClient(Effect.flatMap(GitHubClient, f)))

  const runEither = <A, E>(f: (client: GitHubClient["Type"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(withClient(Effect.either(Effect.flatMap(GitHubClient, f))))

  const userResponse = () =>
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-OAuth-Scopes": "repo, read:org" },
    })

  describe("validateToken", () => {
    it("default (no host) still hits api.github.com", async () => {
      const calls = recordFetch(userResponse)
      const result = await run((c) => c.validateToken("ghp_x"))
      expect(result.user.login).toBe("octocat")
      expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/user"])
    })

    it("github.com → https://api.github.com", async () => {
      const calls = recordFetch(userResponse)
      await run((c) => c.validateToken("ghp_x", "github.com"))
      expect(calls[0].url).toBe("https://api.github.com/user")
    })

    it("GHES → https://<host>/api/v3 (incl. port), token sent there", async () => {
      const calls = recordFetch(userResponse)
      const result = await run((c) => c.validateToken("ghp_x", "ghes.example.com:8443"))
      expect(result.scopes).toEqual(["repo", "read:org"])
      expect(calls).toEqual([
        { url: "https://ghes.example.com:8443/api/v3/user", method: "GET", authorization: "Bearer ghp_x" },
      ])
    })

    it("ghe.com tenant → https://api.<sub>.ghe.com", async () => {
      const calls = recordFetch(userResponse)
      await run((c) => c.validateToken("ghp_x", "acme.ghe.com"))
      expect(calls[0].url).toBe("https://api.acme.ghe.com/user")
    })

    it("accepts a URL-form host and normalizes it", async () => {
      const calls = recordFetch(userResponse)
      await run((c) => c.validateToken("ghp_x", "https://GHES.example.com/org/repo"))
      expect(calls[0].url).toBe("https://ghes.example.com/api/v3/user")
    })

    it("http:// input still goes over https", async () => {
      const calls = recordFetch(userResponse)
      await run((c) => c.validateToken("ghp_x", "http://ghes.internal"))
      expect(calls[0].url).toBe("https://ghes.internal/api/v3/user")
    })

    it("GitHub App installation token probes /installation/repositories on the host's API", async () => {
      const calls = recordFetch(() => json({ total_count: 1, repositories: [{ owner: { login: "acme" } }] }))
      const result = await run((c) => c.validateToken("ghs_x", "ghes.example.com"))
      expect(result.user.login).toBe("acme[bot]")
      expect(calls[0].url).toBe("https://ghes.example.com/api/v3/installation/repositories?per_page=1")
    })
  })

  describe("an unparseable host fails with status 400 and makes NO request", () => {
    const BAD_HOSTS = ["ftp://ghes.example.com", "https://user:pw@ghes.example.com", "not a host", "", "   "]

    for (const bad of BAD_HOSTS) {
      it(`validateToken(${JSON.stringify(bad)})`, async () => {
        const calls = recordFetch()
        const result = await runEither((c) => c.validateToken("ghp_secret", bad))
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("GitHubApiError")
          expect(result.left.status).toBe(400)
        }
        expect(calls).toHaveLength(0)
      })
    }

    it("every method refuses (no github.com fallback)", async () => {
      const calls = recordFetch()
      const bad = "ftp://ghes.example.com"
      const attempts = [
        runEither((c) => c.startOAuthDeviceFlow("cid", ["repo"], bad)),
        runEither((c) => c.pollOAuthToken("cid", "dev", bad)),
        runEither((c) => c.listOrgs("t", bad)),
        runEither((c) => c.listRepos("t", "o", undefined, bad)),
        runEither((c) => c.getRepo("t", "o", "r", bad)),
        runEither((c) => c.listRefs("t", "o", "r", undefined, bad)),
        runEither((c) => c.listLabels("t", "o", "r", bad)),
        runEither((c) =>
          c.createPullRequest("t", { owner: "o", repo: "r", title: "x", body: "", baseBranch: "main", headBranch: "f" }, bad),
        ),
        runEither((c) => c.addLabels("t", "o", "r", 1, ["bug"], bad)),
      ]
      for (const result of await Promise.all(attempts)) {
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") expect(result.left.status).toBe(400)
      }
      expect(calls).toHaveLength(0)
    })
  })

  describe("listOrgs", () => {
    it("GHES → /api/v3/user/orgs", async () => {
      const calls = recordFetch(() => json([{ id: 1, login: "corp" }]))
      const orgs = await run((c) => c.listOrgs("t", "ghes.example.com"))
      expect(orgs).toEqual([{ id: 1, login: "corp", name: undefined }])
      expect(calls.map((c) => c.url)).toEqual(["https://ghes.example.com/api/v3/user/orgs?per_page=100&page=1"])
    })

    it("ghe.com → api.<sub>.ghe.com/user/orgs", async () => {
      const calls = recordFetch(() => json([]))
      await run((c) => c.listOrgs("t", "acme.ghe.com"))
      expect(calls[0].url).toBe("https://api.acme.ghe.com/user/orgs?per_page=100&page=1")
    })

    it("default → api.github.com/user/orgs", async () => {
      const calls = recordFetch(() => json([]))
      await run((c) => c.listOrgs("t"))
      expect(calls[0].url).toBe("https://api.github.com/user/orgs?per_page=100&page=1")
    })
  })

  describe("listRepos / listRefs / listLabels / getRepo", () => {
    it("all stay on the GHES API base", async () => {
      const calls = recordFetch((url) =>
        url.endsWith("/repos/o/r")
          ? json({ id: 1, name: "r", full_name: "o/r", private: false, default_branch: "main", owner: { id: 2 } })
          : url.includes("/orgs/o") && !url.includes("/repos")
            ? json({ login: "o" })
            : json([]),
      )
      await run((c) => c.listRepos("t", "o", undefined, "ghes.example.com"))
      await run((c) => c.listRefs("t", "o", "r", undefined, "ghes.example.com"))
      await run((c) => c.listLabels("t", "o", "r", "ghes.example.com"))
      await run((c) => c.getRepo("t", "o", "r", "ghes.example.com"))
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.url.startsWith("https://ghes.example.com/api/v3/")).toBe(true)
      }
    })
  })

  describe("createPullRequest", () => {
    const params = {
      owner: "o",
      repo: "r",
      title: "t",
      body: "b",
      baseBranch: "main",
      headBranch: "feat",
      labels: ["bug"],
    }
    const prResponse = (url: string) =>
      url.endsWith("/pulls")
        ? json({ html_url: "https://ghes.example.com/o/r/pull/7", number: 7, head: { ref: "feat" } }, 201)
        : json([])

    it("GHES: PR + labels POSTed to https://<host>/api/v3", async () => {
      const calls = recordFetch(prResponse)
      const result = await run((c) => c.createPullRequest("t", params, "ghes.example.com"))
      expect(result).toEqual({ url: "https://ghes.example.com/o/r/pull/7", number: 7, branch: "feat" })
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["POST", "https://ghes.example.com/api/v3/repos/o/r/pulls"],
        ["POST", "https://ghes.example.com/api/v3/repos/o/r/issues/7/labels"],
      ])
    })

    it("ghe.com: api.<sub>.ghe.com", async () => {
      const calls = recordFetch(prResponse)
      await run((c) => c.createPullRequest("t", params, "acme.ghe.com"))
      expect(calls[0].url).toBe("https://api.acme.ghe.com/repos/o/r/pulls")
    })

    it("default: api.github.com", async () => {
      const calls = recordFetch(prResponse)
      await run((c) => c.createPullRequest("t", params))
      expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls")
    })
  })

  describe("OAuth device flow endpoints (web origin)", () => {
    const deviceResponse = () =>
      json({ device_code: "dc", user_code: "UC", verification_uri: "https://ghes.example.com/login/device", interval: 5 })

    it("GHES: /login/device/code and /login/oauth/access_token on https://<host>", async () => {
      const calls = recordFetch((url) =>
        url.endsWith("/login/device/code") ? deviceResponse() : json({ access_token: "gho_new" }),
      )
      const start = await run((c) => c.startOAuthDeviceFlow("Iv1.ghes", ["repo"], "ghes.example.com:8443"))
      expect(start.verificationUri).toBe("https://ghes.example.com/login/device")
      const poll = await run((c) => c.pollOAuthToken("Iv1.ghes", "dc", "ghes.example.com:8443"))
      expect(poll).toEqual({ token: "gho_new" })
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["POST", "https://ghes.example.com:8443/login/device/code"],
        ["POST", "https://ghes.example.com:8443/login/oauth/access_token"],
      ])
    })

    it("ghe.com: device flow on the tenant web origin (not the api. origin)", async () => {
      const calls = recordFetch((url) =>
        url.endsWith("/login/device/code") ? deviceResponse() : json({ error: "authorization_pending" }),
      )
      await run((c) => c.startOAuthDeviceFlow("Iv1.ghec", ["repo"], "acme.ghe.com"))
      const poll = await run((c) => c.pollOAuthToken("Iv1.ghec", "dc", "acme.ghe.com"))
      expect(poll).toEqual({ pending: true })
      expect(calls.map((c) => c.url)).toEqual([
        "https://acme.ghe.com/login/device/code",
        "https://acme.ghe.com/login/oauth/access_token",
      ])
    })

    it("default: github.com", async () => {
      const calls = recordFetch((url) =>
        url.endsWith("/login/device/code") ? deviceResponse() : json({ access_token: "gho_x" }),
      )
      await run((c) => c.startOAuthDeviceFlow("cid", ["repo"]))
      await run((c) => c.pollOAuthToken("cid", "dc"))
      expect(calls.map((c) => c.url)).toEqual([
        "https://github.com/login/device/code",
        "https://github.com/login/oauth/access_token",
      ])
    })
  })
})
