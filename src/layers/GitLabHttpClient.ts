/**
 * Live implementation of the GitLabClient service using fetch.
 *
 * Mirrors GitHubHttpClient, but targets GitLab's REST API. The instance origin
 * is per-call (`baseUrl`, defaulting to gitlab.com) so a self-hosted GitLab is
 * supported — the auth block supplies either a picked host or a manually-entered
 * instance URL, and operations on a cloned repo derive it from the repo's own
 * remote. A bare host or a full URL is accepted; the client normalizes it.
 * Auth is Bearer-FIRST (vcs-auth-v2-design.md §3.3): `Authorization: Bearer`
 * works for both `glpat-` PATs and glab's unprefixed OAuth tokens (which
 * `PRIVATE-TOKEN` rejects), so the common case is one round trip; we retry
 * once with `PRIVATE-TOKEN` on a 401 for old self-hosted instances.
 * Unlike GitHub, `GET /user` exposes no scope header, so token scopes are
 * introspected with a second, best-effort call keyed on token shape
 * (`glpat-` → `/personal_access_tokens/self`, otherwise `/oauth/token/info`).
 */
import { Effect, Layer } from "effect"
import { GitLabClient } from "../services/GitLabClient.ts"
import type {
  GitLabClientShape,
  GitLabTokenValidation,
  GitLabTokenType,
  CreateMRParams,
  MergeRequestResult,
} from "../services/GitLabClient.ts"
import { GitLabApiError } from "../errors/index.ts"
import { gitlabApiBase, normalizeGitLabBaseUrl } from "../domain/git/gitlab-host.ts"
import { classifyTlsError } from "../domain/tls/system-ca.ts"

type AuthScheme = "private" | "bearer"

// status 0 = no HTTP response; `kind` carries the transport classification.
const toGitLabApiError = (err: unknown): GitLabApiError =>
  err instanceof GitLabApiError
    ? err
    : new GitLabApiError({ status: 0, message: `${err}`, kind: classifyTlsError(err) })

async function assertOk(resp: Response): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new GitLabApiError({ status: resp.status, message: body || resp.statusText })
  }
}

function authHeaders(token: string, scheme: AuthScheme): Record<string, string> {
  return scheme === "private"
    ? { Accept: "application/json", "PRIVATE-TOKEN": token }
    : { Accept: "application/json", Authorization: `Bearer ${token}` }
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const scopes = value.filter((v): v is string => typeof v === "string")
  return scopes.length > 0 ? scopes : undefined
}

/**
 * Best-effort token scope lookup. GitLab's `GET /user` exposes no scopes, so we
 * introspect separately: PATs via `/api/v4/personal_access_tokens/self`
 * (`scopes` — the `self` keyword landed in GitLab 15.5; older instances 404,
 * which is silently "no scope info"), OAuth tokens via `/oauth/token/info`
 * (`scope`, Bearer). Which shape we hold is decided by the scheme that just
 * VALIDATED the token, not the `glpat-` prefix alone: PRIVATE-TOKEN only ever
 * validates PATs, and self-managed instances can configure a custom PAT
 * prefix, so a non-glpat Bearer-validated token may be either shape — we try
 * the likelier endpoint first and fall back to the other. Returns undefined
 * when scopes can't be determined (e.g. a project/group token, a non-200
 * response, or a network error) — scope display is enrichment and must never
 * block validation.
 */
async function fetchScopes(
  token: string,
  scheme: AuthScheme,
  baseUrl: string,
): Promise<string[] | undefined> {
  const patProbe = [`${gitlabApiBase(baseUrl)}/personal_access_tokens/self`, "scopes", authHeaders(token, scheme)] as const
  const oauthProbe = [`${baseUrl}/oauth/token/info`, "scope", authHeaders(token, "bearer")] as const
  // A known PAT (PRIVATE-TOKEN-validated, or the stock glpat- prefix) can
  // only introspect via the PAT endpoint — /oauth/token/info would 401. A
  // non-glpat Bearer-validated token is EITHER glab's OAuth token or a
  // custom-prefix PAT: try OAuth first, then fall back to the PAT endpoint
  // so custom-prefix PATs keep their scopes (and the missing-scope warning).
  const probes =
    scheme === "private" || token.startsWith("glpat-") ? [patProbe] : [oauthProbe, patProbe]
  for (const [url, field, headers] of probes) {
    try {
      const resp = await fetch(url, { headers })
      if (!resp.ok) continue
      const data = (await resp.json()) as Record<string, unknown>
      const scopes = toStringArray(data[field])
      if (scopes) return scopes
    } catch {
      /* best-effort */
    }
  }
  return undefined
}

/**
 * Authenticated GitLab API request, Bearer-FIRST (§3.3): Bearer authenticates
 * both `glpat-` PATs and glab's unprefixed OAuth tokens (which PRIVATE-TOKEN
 * rejects), halving the common-case round trips. We retry once with
 * PRIVATE-TOKEN on a 401 only, for old self-hosted instances. Any
 * caller-supplied headers (e.g. Content-Type for a POST body) are merged
 * after the auth headers.
 */
async function gitlabFetch(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const extra = init.headers as Record<string, string> | undefined
  let scheme: AuthScheme = "bearer"
  let resp = await fetch(url, { ...init, headers: { ...extra, ...authHeaders(token, scheme) } })
  if (resp.status === 401) {
    scheme = "private"
    resp = await fetch(url, { ...init, headers: { ...extra, ...authHeaders(token, scheme) } })
  }
  return resp
}

/**
 * Fetch every page of a GitLab list endpoint, following the `x-next-page`
 * header. GitLab omits total-count headers for result sets over 10,000 records,
 * so we drive the loop off `x-next-page` (and a short final page) rather than
 * `x-total-pages`. Mirrors GitHubHttpClient.paginateAll.
 */
async function paginateAll<T>(
  url: string,
  token: string,
  perPage = 100,
): Promise<T[]> {
  const results: T[] = []
  let page = 1
  while (true) {
    const sep = url.includes("?") ? "&" : "?"
    const resp = await gitlabFetch(`${url}${sep}per_page=${perPage}&page=${page}`, token)
    await assertOk(resp)
    const items = (await resp.json()) as T[]
    results.push(...items)
    const next = resp.headers.get("x-next-page")
    if (!next || items.length < perPage) break
    const nextPage = Number(next)
    if (!Number.isFinite(nextPage) || nextPage <= page) break
    page = nextPage
  }
  return results
}

async function validateUserToken(
  token: string,
  baseUrl: string,
): Promise<GitLabTokenValidation> {
  const apiBase = gitlabApiBase(baseUrl)
  // Bearer-first (§3.3): Bearer accepts both glpat- PATs and glab's
  // unprefixed OAuth tokens (which PRIVATE-TOKEN rejects with 401), so the
  // common case is one round trip. Retry with PRIVATE-TOKEN only on 401 (old
  // self-hosted instances) — a 403 means the token authenticated but lacks
  // the scope to read /user, which a scheme change (same token, same scopes)
  // can't fix.
  let scheme: AuthScheme = "bearer"
  let resp = await fetch(`${apiBase}/user`, { headers: authHeaders(token, scheme) })
  if (resp.status === 401) {
    scheme = "private"
    resp = await fetch(`${apiBase}/user`, { headers: authHeaders(token, scheme) })
  }
  await assertOk(resp)
  const data = (await resp.json()) as {
    username: string
    name?: string
    avatar_url?: string
    email?: string
  }
  // GET /user exposes no scopes; introspect them with the scheme that validated.
  const scopes = await fetchScopes(token, scheme, baseUrl)
  return {
    user: {
      login: data.username,
      name: data.name,
      avatarUrl: data.avatar_url,
      email: data.email,
    },
    scopes,
  }
}

const impl: GitLabClientShape = {
  validateToken: (token: string, baseUrl?: string) =>
    Effect.tryPromise({
      try: (): Promise<GitLabTokenValidation> =>
        validateUserToken(token, normalizeGitLabBaseUrl(baseUrl)),
      catch: toGitLabApiError,
    }),

  detectTokenType: (token: string): GitLabTokenType =>
    token.startsWith("glpat-") ? "pat" : "unknown",

  createMergeRequest: (token: string, params: CreateMRParams) =>
    Effect.tryPromise({
      try: async (): Promise<MergeRequestResult> => {
        const apiBase = gitlabApiBase(normalizeGitLabBaseUrl(params.baseUrl))
        // `:id` is the URL-encoded full project path; encodeURIComponent turns
        // the slashes of a nested group path (group/subgroup/project) into %2F.
        const projectId = encodeURIComponent(`${params.owner}/${params.repo}`)
        const body: Record<string, unknown> = {
          source_branch: params.headBranch,
          target_branch: params.baseBranch,
          title: params.title,
        }
        if (params.body) body.description = params.body
        // On create, `labels` is a comma-separated STRING (the response returns
        // them as an array). Set inline — no separate add-labels round-trip.
        if (params.labels && params.labels.length > 0) {
          body.labels = params.labels.join(",")
        }
        const resp = await gitlabFetch(
          `${apiBase}/projects/${projectId}/merge_requests`,
          token,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        )
        await assertOk(resp)
        // `iid` is the project-scoped, user-facing number (!42); `id` is the
        // global DB id — never surface that one.
        const data = (await resp.json()) as {
          web_url: string
          iid: number
          source_branch: string
        }
        return { url: data.web_url, number: data.iid, branch: data.source_branch }
      },
      catch: toGitLabApiError,
    }),

  listLabels: (token: string, owner: string, repo: string, baseUrl?: string) =>
    Effect.tryPromise({
      try: async (): Promise<string[]> => {
        const apiBase = gitlabApiBase(normalizeGitLabBaseUrl(baseUrl))
        const projectId = encodeURIComponent(`${owner}/${repo}`)
        const labels = await paginateAll<{ name: string }>(
          `${apiBase}/projects/${projectId}/labels?include_ancestor_groups=true`,
          token,
        )
        return labels.map((l) => l.name)
      },
      catch: toGitLabApiError,
    }),
}

export const GitLabHttpClientLive = Layer.succeed(GitLabClient, impl)
