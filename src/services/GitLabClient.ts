import { Context, Effect } from "effect"
import type { GitLabApiError } from "../errors/index.ts"

export interface GitLabUser {
  readonly login: string
  readonly name?: string
  readonly avatarUrl?: string
  readonly email?: string
}

export interface GitLabTokenValidation {
  readonly user: GitLabUser
  /**
   * GitLab's `GET /user` endpoint exposes no scope header, so token scopes are
   * not reliably discoverable for personal access tokens. Always undefined for
   * now; introspecting scopes via `GET /personal_access_tokens/self` is a
   * possible follow-up.
   */
  readonly scopes?: string[]
}

export type GitLabTokenType = "pat" | "oauth" | "unknown"

export interface GitLabClientShape {
  readonly validateToken: (token: string) => Effect.Effect<GitLabTokenValidation, GitLabApiError>
  readonly detectTokenType: (token: string) => GitLabTokenType
}

export class GitLabClient extends Context.Tag("GitLabClient")<GitLabClient, GitLabClientShape>() {}
