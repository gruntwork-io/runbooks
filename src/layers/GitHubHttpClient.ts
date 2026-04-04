/**
 * Live implementation of the GitHubClient service using fetch.
 */
import { Effect, Layer } from "effect"
import { GitHubClient } from "../services/GitHubClient.ts"
import type {
  GitHubClientShape,
  GitHubUser,
  GitHubTokenType,
  DeviceFlowStart,
  OAuthPollResult,
  GitHubOrg,
  GitHubRepo,
  GitHubRef,
  CreatePRParams,
  PullRequestResult,
} from "../services/GitHubClient.ts"
import { GitHubApiError } from "../errors/index.ts"

const API_BASE = "https://api.github.com"
const OAUTH_BASE = "https://github.com"

async function githubFetch(
  url: string,
  options: RequestInit & { token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`
  }
  const resp = await fetch(url, { ...options, headers })
  return resp
}

async function githubJson<T>(
  url: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const resp = await githubFetch(url, options)
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new GitHubApiError({ status: resp.status, message: body || resp.statusText })
  }
  return (await resp.json()) as T
}

async function paginateAll<T>(
  baseUrl: string,
  token: string,
  perPage = 100,
): Promise<T[]> {
  const results: T[] = []
  let page = 1
  while (true) {
    const sep = baseUrl.includes("?") ? "&" : "?"
    const url = `${baseUrl}${sep}per_page=${perPage}&page=${page}`
    const resp = await githubFetch(url, { token })
    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      throw new GitHubApiError({ status: resp.status, message: body || resp.statusText })
    }
    const items = (await resp.json()) as T[]
    results.push(...items)
    if (items.length < perPage) break
    page++
  }
  return results
}

const impl: GitHubClientShape = {
  validateToken: (token: string) =>
    Effect.tryPromise({
      try: async (): Promise<GitHubUser> => {
        const data = await githubJson<{
          login: string
          name?: string
          avatar_url?: string
          email?: string
        }>(`${API_BASE}/user`, { token })
        return {
          login: data.login,
          name: data.name,
          avatarUrl: data.avatar_url,
          email: data.email,
        }
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  detectTokenType: (token: string): GitHubTokenType => {
    if (token.startsWith("ghp_")) return "classic_pat"
    if (token.startsWith("github_pat_")) return "fine_grained_pat"
    if (token.startsWith("gho_")) return "oauth"
    if (token.startsWith("ghs_") || token.startsWith("ghu_")) return "github_app"
    return "unknown"
  },

  startOAuthDeviceFlow: (clientId: string, scopes: string[]) =>
    Effect.tryPromise({
      try: async (): Promise<DeviceFlowStart> => {
        const resp = await fetch(`${OAUTH_BASE}/login/device/code`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            scope: scopes.join(" "),
          }),
        })
        if (!resp.ok) {
          const body = await resp.text().catch(() => "")
          throw new GitHubApiError({ status: resp.status, message: body || resp.statusText })
        }
        const data = (await resp.json()) as {
          device_code: string
          user_code: string
          verification_uri: string
          interval: number
        }
        return {
          deviceCode: data.device_code,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          interval: data.interval,
        }
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  pollOAuthToken: (clientId: string, deviceCode: string) =>
    Effect.tryPromise({
      try: async (): Promise<OAuthPollResult> => {
        const resp = await fetch(`${OAUTH_BASE}/login/oauth/access_token`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        })
        if (!resp.ok) {
          const body = await resp.text().catch(() => "")
          throw new GitHubApiError({ status: resp.status, message: body || resp.statusText })
        }
        const data = (await resp.json()) as {
          access_token?: string
          error?: string
        }
        if (data.error === "authorization_pending" || data.error === "slow_down") {
          return { pending: true }
        }
        if (data.error) {
          throw new GitHubApiError({ status: 400, message: data.error })
        }
        return { token: data.access_token }
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  listOrgs: (token: string) =>
    Effect.tryPromise({
      try: async (): Promise<GitHubOrg[]> => {
        const orgs = await paginateAll<{ login: string; description?: string }>(
          `${API_BASE}/user/orgs`,
          token,
        )
        return orgs.map((o) => ({ login: o.login, name: o.description }))
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  listRepos: (token: string, owner: string, query?: string) =>
    Effect.tryPromise({
      try: async (): Promise<GitHubRepo[]> => {
        // Determine if owner is an org or user
        let url: string
        try {
          const resp = await githubFetch(`${API_BASE}/orgs/${owner}`, { token })
          url = resp.ok
            ? `${API_BASE}/orgs/${owner}/repos`
            : `${API_BASE}/user/repos`
        } catch {
          url = `${API_BASE}/user/repos`
        }

        const repos = await paginateAll<{
          name: string
          full_name: string
          private: boolean
          default_branch: string
        }>(url, token)

        let filtered = repos
        if (query) {
          const q = query.toLowerCase()
          filtered = repos.filter((r) => r.name.toLowerCase().includes(q))
        }

        return filtered.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch,
        }))
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  listRefs: (token: string, owner: string, repo: string, query?: string) =>
    Effect.tryPromise({
      try: async (): Promise<GitHubRef[]> => {
        const [branches, tags] = await Promise.all([
          paginateAll<{ name: string }>(`${API_BASE}/repos/${owner}/${repo}/branches`, token),
          paginateAll<{ name: string }>(`${API_BASE}/repos/${owner}/${repo}/tags`, token),
        ])

        const refs: GitHubRef[] = [
          ...branches.map((b) => ({ ref: b.name, type: "branch" as const })),
          ...tags.map((t) => ({ ref: t.name, type: "tag" as const })),
        ]

        if (query) {
          const q = query.toLowerCase()
          return refs.filter((r) => r.ref.toLowerCase().includes(q))
        }
        return refs
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  listLabels: (token: string, owner: string, repo: string) =>
    Effect.tryPromise({
      try: async (): Promise<string[]> => {
        const labels = await paginateAll<{ name: string }>(
          `${API_BASE}/repos/${owner}/${repo}/labels`,
          token,
        )
        return labels.map((l) => l.name)
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  createPullRequest: (token: string, params: CreatePRParams) =>
    Effect.tryPromise({
      try: async (): Promise<PullRequestResult> => {
        const data = await githubJson<{
          html_url: string
          number: number
          head: { ref: string }
        }>(`${API_BASE}/repos/${params.owner}/${params.repo}/pulls`, {
          method: "POST",
          token,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: params.title,
            body: params.body,
            base: params.baseBranch,
            head: params.headBranch,
          }),
        })

        // Add labels if provided
        if (params.labels && params.labels.length > 0) {
          await githubJson(
            `${API_BASE}/repos/${params.owner}/${params.repo}/issues/${data.number}/labels`,
            {
              method: "POST",
              token,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ labels: params.labels }),
            },
          )
        }

        return {
          url: data.html_url,
          number: data.number,
          branch: data.head.ref,
        }
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),

  addLabels: (token: string, owner: string, repo: string, prNumber: number, labels: string[]) =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        await githubJson(
          `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/labels`,
          {
            method: "POST",
            token,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ labels }),
          },
        )
      },
      catch: (err) =>
        err instanceof GitHubApiError
          ? err
          : new GitHubApiError({ status: 0, message: `${err}` }),
    }),
}

export const GitHubHttpClientLive = Layer.succeed(GitHubClient, impl)
