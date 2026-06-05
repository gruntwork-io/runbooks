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

/**
 * Parameters for creating a merge request. Field names mirror GitHub's
 * CreatePRParams so the domain layer can build either from one shape:
 *   - `owner` is the project's namespace path (group, or group/subgroup).
 *   - `repo` is the project name. `owner/repo` is URL-encoded into the
 *     `:id` path segment (slashes become %2F).
 *   - `headBranch` -> GitLab `source_branch`, `baseBranch` -> `target_branch`.
 */
export interface CreateMRParams {
  readonly owner: string
  readonly repo: string
  readonly title: string
  readonly body?: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly labels?: string[]
}

/**
 * Result of a created merge request. `number` is the project-scoped **iid**
 * (the user-facing `!42`), NOT the global `id`. Shape matches GitHub's
 * PullRequestResult so the renderer's git:pr-result contract is reused.
 */
export interface MergeRequestResult {
  readonly url: string
  readonly number: number
  readonly branch: string
}

export interface GitLabClientShape {
  readonly validateToken: (token: string) => Effect.Effect<GitLabTokenValidation, GitLabApiError>
  readonly detectTokenType: (token: string) => GitLabTokenType
  readonly createMergeRequest: (token: string, params: CreateMRParams) => Effect.Effect<MergeRequestResult, GitLabApiError>
  readonly listLabels: (token: string, owner: string, repo: string) => Effect.Effect<string[], GitLabApiError>
}

export class GitLabClient extends Context.Tag("GitLabClient")<GitLabClient, GitLabClientShape>() {}
