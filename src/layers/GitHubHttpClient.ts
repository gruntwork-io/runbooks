/**
 * Live implementation of the GitHubClient service using fetch.
 */
import { Effect, Layer } from "effect"
import { GitHubClient } from "../services/GitHubClient.ts"
import type {
  GitHubClientShape,
  GitHubTokenValidation,
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

const toGitHubApiError = (err: unknown): GitHubApiError =>
  err instanceof GitHubApiError ? err : new GitHubApiError({ status: 0, message: `${err}` })

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
  return fetch(url, { ...options, headers })
}

async function assertOk(resp: Response): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new GitHubApiError({ status: resp.status, message: body || resp.statusText })
  }
}

async function githubJson<T>(
  url: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const resp = await githubFetch(url, options)
  await assertOk(resp)
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
    await assertOk(resp)
    const items = (await resp.json()) as T[]
    results.push(...items)
    if (items.length < perPage) break
    page++
  }
  return results
}

// GitHub App installation tokens (ghs_) can't call /user — GitHub returns
// 403 "Resource not accessible by integration" because the token has no user
// context. Probe /installation/repositories instead and synthesize an
// identity from the installation owner.
async function validateInstallationToken(
  token: string,
): Promise<GitHubTokenValidation> {
  const resp = await githubFetch(
    `${API_BASE}/installation/repositories?per_page=1`,
    { token },
  )
  await assertOk(resp)
  const data = (await resp.json()) as {
    total_count: number
    repositories: Array<{ owner?: { login?: string } }>
  }
  const ownerLogin = data.repositories[0]?.owner?.login
  return {
    user: {
      login: ownerLogin ? `${ownerLogin}[bot]` : "github-app[bot]",
      name: "GitHub App Installation",
    },
  }
}

async function validateUserToken(
  token: string,
): Promise<GitHubTokenValidation> {
  const resp = await githubFetch(`${API_BASE}/user`, { token })
  await assertOk(resp)
  const data = (await resp.json()) as {
    login: string
    name?: string
    avatar_url?: string
    email?: string
  }
  const scopeHeader = resp.headers.get("x-oauth-scopes")
  const scopes = scopeHeader
    ? scopeHeader
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined
  return {
    user: {
      login: data.login,
      name: data.name,
      avatarUrl: data.avatar_url,
      email: data.email,
    },
    scopes,
  }
}

const impl: GitHubClientShape = {
  validateToken: (token: string) =>
    Effect.tryPromise({
      try: async (): Promise<GitHubTokenValidation> =>
        token.startsWith("ghs_")
          ? validateInstallationToken(token)
          : validateUserToken(token),
      catch: toGitHubApiError,
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
        await assertOk(resp)
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
      catch: toGitHubApiError,
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
        await assertOk(resp)
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
      catch: toGitHubApiError,
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
      catch: toGitHubApiError,
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
      catch: toGitHubApiError,
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
      catch: toGitHubApiError,
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
      catch: toGitHubApiError,
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
      catch: toGitHubApiError,
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
      catch: toGitHubApiError,
    }),
}

export const GitHubHttpClientLive = Layer.succeed(GitHubClient, impl)
