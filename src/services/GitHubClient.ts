import { Context, Effect } from "effect"
import type { GitHubApiError } from "../errors/index.ts"

export interface GitHubUser {
  readonly login: string
  readonly name?: string | undefined
  readonly avatarUrl?: string | undefined
  readonly email?: string | undefined
}

export interface GitHubTokenValidation {
  readonly user: GitHubUser
  /** Scopes parsed from the X-OAuth-Scopes response header. Undefined for fine-grained PATs and GitHub App tokens. */
  readonly scopes?: string[] | undefined
  /**
   * When the token expires, as an ISO timestamp, from the
   * GitHub-Authentication-Token-Expiration response header. Undefined for a
   * token that doesn't expire.
   */
  readonly expiresAt?: string | undefined
}

export interface DeviceFlowStart {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly interval: number
  /** Seconds until the device code expires (GitHub's default is 900). */
  readonly expiresIn: number
}

export interface OAuthPollResult {
  readonly token?: string | undefined
  readonly pending?: boolean
  /** GitHub answered slow_down: poll less often (RFC 8628 §3.5). */
  readonly slowDown?: boolean
  /** The minimum poll interval in seconds GitHub sent with slow_down. */
  readonly interval?: number | undefined
}

export interface GitHubOrg {
  /** GitHub numeric database ID — stable across renames. */
  readonly id: number
  readonly login: string
  readonly name?: string | undefined
}

export interface GitHubRepo {
  /** GitHub numeric database ID — stable across renames and transfers. */
  readonly id: number
  /** Numeric database ID of the owning user or organization. */
  readonly ownerId: number
  readonly name: string
  readonly fullName: string
  readonly private: boolean
  readonly defaultBranch: string
}

export interface GitHubRef {
  readonly ref: string
  readonly type: "branch" | "tag"
}

export interface CreatePRParams {
  readonly owner: string
  readonly repo: string
  readonly title: string
  readonly body?: string | undefined
  readonly baseBranch: string
  readonly headBranch: string
}

export interface PullRequestResult {
  readonly url: string
  readonly number: number
  readonly branch: string
}

export type GitHubTokenType =
  | "classic_pat"
  | "fine_grained_pat"
  | "oauth"
  | "github_app"
  | "unknown"

/**
 * Every method takes an optional trailing `host` — the GitHub host to target
 * (`github.com`, a GHES host, or a `<sub>.ghe.com` tenant; a bare host or a
 * URL). It defaults to github.com. A `host` that is given but unparseable
 * FAILS the call rather than falling back to github.com, so a token is never
 * sent to a host other than the one the caller named.
 */
export interface GitHubClientShape {
  readonly validateToken: (
    token: string,
    host?: string,
  ) => Effect.Effect<GitHubTokenValidation, GitHubApiError>
  readonly startOAuthDeviceFlow: (
    clientId: string,
    scopes: string[],
    host?: string,
  ) => Effect.Effect<DeviceFlowStart, GitHubApiError>
  readonly pollOAuthToken: (
    clientId: string,
    deviceCode: string,
    host?: string,
  ) => Effect.Effect<OAuthPollResult, GitHubApiError>
  readonly listOrgs: (token: string, host?: string) => Effect.Effect<GitHubOrg[], GitHubApiError>
  readonly listRepos: (
    token: string,
    owner: string,
    query?: string,
    host?: string,
  ) => Effect.Effect<GitHubRepo[], GitHubApiError>
  readonly getRepo: (
    token: string,
    owner: string,
    repo: string,
    host?: string,
  ) => Effect.Effect<GitHubRepo, GitHubApiError>
  readonly listRefs: (
    token: string,
    owner: string,
    repo: string,
    query?: string,
    host?: string,
  ) => Effect.Effect<GitHubRef[], GitHubApiError>
  readonly listLabels: (
    token: string,
    owner: string,
    repo: string,
    host?: string,
  ) => Effect.Effect<string[], GitHubApiError>
  readonly createPullRequest: (
    token: string,
    params: CreatePRParams,
    host?: string,
  ) => Effect.Effect<PullRequestResult, GitHubApiError>
  readonly addLabels: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[],
    host?: string,
  ) => Effect.Effect<void, GitHubApiError>
}

export class GitHubClient extends Context.Tag("GitHubClient")<GitHubClient, GitHubClientShape>() {}
