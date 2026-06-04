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
   * GitLab's `GET /user` exposes no scope header, so scopes are introspected
   * separately (best-effort): `/oauth/token/info` for OAuth tokens and
   * `/personal_access_tokens/self` for personal access tokens. Undefined when
   * scopes can't be determined (e.g. a project/group token or an introspection
   * failure).
   */
  readonly scopes?: string[]
}

export type GitLabTokenType = "pat" | "oauth" | "unknown"

export interface GitLabClientShape {
  readonly validateToken: (token: string) => Effect.Effect<GitLabTokenValidation, GitLabApiError>
  readonly detectTokenType: (token: string) => GitLabTokenType
}

export class GitLabClient extends Context.Tag("GitLabClient")<GitLabClient, GitLabClientShape>() {}
