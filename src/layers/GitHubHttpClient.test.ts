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
