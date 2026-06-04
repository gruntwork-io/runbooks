/**
 * Live implementation of the GitLabClient service using fetch.
 *
 * Mirrors GitHubHttpClient, but targets gitlab.com's REST API. Personal,
 * project, and group access tokens authenticate via the `PRIVATE-TOKEN` header;
 * OAuth tokens (e.g. from `glab auth login`'s web flow) are rejected by it and
 * require `Authorization: Bearer`, so we fall back to Bearer on an auth failure.
 * Unlike GitHub, `GET /user` exposes no scope header, so token scopes are
 * introspected with a second, best-effort call (`/oauth/token/info` for OAuth
 * tokens, `/personal_access_tokens/self` for PATs).
 */
import { Effect, Layer } from "effect"
import { GitLabClient } from "../services/GitLabClient.ts"
import type {
  GitLabClientShape,
  GitLabTokenValidation,
  GitLabTokenType,
} from "../services/GitLabClient.ts"
import { GitLabApiError } from "../errors/index.ts"

const GITLAB_BASE = "https://gitlab.com"
const API_BASE = `${GITLAB_BASE}/api/v4`

type AuthScheme = "private" | "bearer"

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
 * introspect separately using the scheme that just authenticated the token:
 * OAuth tokens (Bearer) via `/oauth/token/info` (`scope`), and personal access
 * tokens (PRIVATE-TOKEN) via `/api/v4/personal_access_tokens/self` (`scopes`).
 * Returns undefined when scopes can't be determined (e.g. a project/group token,
 * a non-200 response, or a network error) — scope display is enrichment and must
 * never block validation.
 */
async function fetchScopes(
  token: string,
  scheme: AuthScheme,
): Promise<string[] | undefined> {
  try {
    if (scheme === "bearer") {
      const resp = await fetch(`${GITLAB_BASE}/oauth/token/info`, {
        headers: authHeaders(token, "bearer"),
      })
      if (!resp.ok) return undefined
      const data = (await resp.json()) as { scope?: unknown }
      return toStringArray(data.scope)
    }
    const resp = await fetch(`${API_BASE}/personal_access_tokens/self`, {
      headers: authHeaders(token, "private"),
    })
    if (!resp.ok) return undefined
    const data = (await resp.json()) as { scopes?: unknown }
    return toStringArray(data.scopes)
  } catch {
    return undefined
  }
}

async function validateUserToken(token: string): Promise<GitLabTokenValidation> {
  // PATs authenticate via PRIVATE-TOKEN, but OAuth tokens are rejected by it and
  // require Authorization: Bearer (which also accepts PATs). Try PRIVATE-TOKEN
  // first, then retry with Bearer on an auth failure before giving up.
  let scheme: AuthScheme = "private"
  let resp = await fetch(`${API_BASE}/user`, { headers: authHeaders(token, scheme) })
  if (resp.status === 401 || resp.status === 403) {
    scheme = "bearer"
    resp = await fetch(`${API_BASE}/user`, { headers: authHeaders(token, scheme) })
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new GitLabApiError({ status: resp.status, message: body || resp.statusText })
  }
  const data = (await resp.json()) as {
    username: string
    name?: string
    avatar_url?: string
    email?: string
  }
  // GET /user exposes no scopes; introspect them with the scheme that validated.
  const scopes = await fetchScopes(token, scheme)
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
  validateToken: (token: string) =>
    Effect.tryPromise({
      try: (): Promise<GitLabTokenValidation> => validateUserToken(token),
      catch: (err) =>
        err instanceof GitLabApiError
          ? err
          : new GitLabApiError({ status: 0, message: `${err}` }),
    }),

  detectTokenType: (token: string): GitLabTokenType =>
    token.startsWith("glpat-") ? "pat" : "unknown",
}

export const GitLabHttpClientLive = Layer.succeed(GitLabClient, impl)
