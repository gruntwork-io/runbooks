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

describe("GitHubHttpClient listRepos owner resolution", () => {
  const repo = (id: number, owner: string, name: string) => ({
    id,
    name,
    full_name: `${owner}/${name}`,
    private: false,
    default_branch: "main",
    owner: { id: id * 10, login: owner },
  })

  const listRepos = (owner: string) =>
    withClient(
      Effect.gen(function* () {
        const client = yield* GitHubClient
        return yield* client.listRepos("ghp_test", owner)
      }),
    )

  it("lists only a user owner's repos, not every repo the token can reach", async () => {
    mockFetch((url) => {
      if (url.endsWith("/orgs/alice")) return new Response("not found", { status: 404 })
      if (url.includes("/user/repos")) {
        return json([repo(1, "Alice", "dotfiles"), repo(2, "acme", "infra")])
      }
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(listRepos("alice"))

    expect(result.map((r) => r.fullName)).toEqual(["Alice/dotfiles"])
  })

  it("falls back to the user's public repos when the token owns none of theirs", async () => {
    mockFetch((url) => {
      if (url.endsWith("/orgs/bob")) return new Response("not found", { status: 404 })
      if (url.includes("/user/repos")) return json([repo(2, "acme", "infra")])
      if (url.includes("/users/bob/repos")) return json([repo(3, "bob", "site")])
      return new Response("not found", { status: 404 })
    })

    const result = await Effect.runPromise(listRepos("bob"))

    expect(result.map((r) => r.fullName)).toEqual(["bob/site"])
  })

  it("reports a failed org check instead of listing the token's repos", async () => {
    const urls: string[] = []
    mockFetch((url) => {
      urls.push(url)
      if (url.endsWith("/orgs/acme")) return new Response("server error", { status: 500 })
      if (url.includes("/user/repos")) return json([repo(2, "acme", "infra")])
      return new Response("not found", { status: 404 })
    })

    const err = await Effect.runPromise(Effect.flip(listRepos("acme")))

    expect(err).toMatchObject({ _tag: "GitHubApiError", status: 500 })
    expect(urls.some((u) => u.includes("/user/repos"))).toBe(false)
  })
})
