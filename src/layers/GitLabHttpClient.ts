/**
 * Live implementation of the GitLabClient service using fetch.
 *
 * Mirrors GitHubHttpClient, but targets gitlab.com's REST API. GitLab tokens
 * (personal/project/group access tokens and OAuth tokens) authenticate via the
 * `PRIVATE-TOKEN` header. Unlike GitHub, `GET /user` returns no scope header, so
 * token scopes are reported as undefined.
 */
import { Effect, Layer } from "effect"
import { GitLabClient } from "../services/GitLabClient.ts"
import type {
  GitLabClientShape,
  GitLabTokenValidation,
  GitLabTokenType,
} from "../services/GitLabClient.ts"
import { GitLabApiError } from "../errors/index.ts"

const API_BASE = "https://gitlab.com/api/v4"

async function validateUserToken(token: string): Promise<GitLabTokenValidation> {
  const resp = await fetch(`${API_BASE}/user`, {
    headers: {
      Accept: "application/json",
      "PRIVATE-TOKEN": token,
    },
  })
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
  return {
    user: {
      login: data.username,
      name: data.name,
      avatarUrl: data.avatar_url,
      email: data.email,
    },
    // GitLab GET /user exposes no scope header.
    scopes: undefined,
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
