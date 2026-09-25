import { describe, it, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { GitHubHttpClientLive } from "./GitHubHttpClient.ts"
import { GitHubClient } from "../services/GitHubClient.ts"
import type { CreatePRParams } from "../services/GitHubClient.ts"

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

describe("GitHubHttpClient pull requests", () => {
  it("createPullRequest makes exactly one request, a POST to /pulls (labeling is the caller's job)", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json({ html_url: "https://github.com/o/r/pull/42", number: 42, head: { ref: "feat" } }, 201)
    })

    // A stray `labels` field (as the domain used to pass) must not trigger a
    // second, label-applying request whose failure would lose the PR.
    const params = {
      owner: "o",
      repo: "r",
      title: "T",
      body: "B",
      baseBranch: "main",
      headBranch: "feat",
      labels: ["enhancement"],
    } as CreatePRParams

    const result = await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.createPullRequest("ghp_test", params)
        }),
      ),
    )

    expect(result).toEqual({ url: "https://github.com/o/r/pull/42", number: 42, branch: "feat" })
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/o/r/pulls",
        method: "POST",
        body: { title: "T", body: "B", base: "main", head: "feat" },
      },
    ])
  })

  it("addLabels POSTs the labels to the PR's issue", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json([{ name: "enhancement" }])
    })

    await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const client = yield* GitHubClient
          return yield* client.addLabels("ghp_test", "o", "r", 42, ["enhancement"])
        }),
      ),
    )

    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/o/r/issues/42/labels",
        method: "POST",
        body: { labels: ["enhancement"] },
      },
    ])
  })
})
