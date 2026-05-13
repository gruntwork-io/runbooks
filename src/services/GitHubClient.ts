import { Context, Effect } from "effect"
import type { GitHubApiError } from "../errors/index.ts"

export interface GitHubUser {
  readonly login: string
  readonly name?: string
  readonly avatarUrl?: string
  readonly email?: string
}

export interface GitHubTokenValidation {
  readonly user: GitHubUser
  /** Scopes parsed from the X-OAuth-Scopes response header. Undefined for fine-grained PATs and GitHub App tokens. */
  readonly scopes?: string[]
}

export interface DeviceFlowStart {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly interval: number
}

export interface OAuthPollResult {
  readonly token?: string
  readonly pending?: boolean
}

export interface GitHubOrg {
  readonly login: string
  readonly name?: string
}

export interface GitHubRepo {
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
  readonly body?: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly labels?: string[]
}

export interface PullRequestResult {
  readonly url: string
  readonly number: number
  readonly branch: string
}

export type GitHubTokenType = "classic_pat" | "fine_grained_pat" | "oauth" | "github_app" | "unknown"

export interface GitHubClientShape {
  readonly validateToken: (token: string) => Effect.Effect<GitHubTokenValidation, GitHubApiError>
  readonly detectTokenType: (token: string) => GitHubTokenType
  readonly startOAuthDeviceFlow: (clientId: string, scopes: string[]) => Effect.Effect<DeviceFlowStart, GitHubApiError>
  readonly pollOAuthToken: (clientId: string, deviceCode: string) => Effect.Effect<OAuthPollResult, GitHubApiError>
  readonly listOrgs: (token: string) => Effect.Effect<GitHubOrg[], GitHubApiError>
  readonly listRepos: (token: string, owner: string, query?: string) => Effect.Effect<GitHubRepo[], GitHubApiError>
  readonly listRefs: (token: string, owner: string, repo: string, query?: string) => Effect.Effect<GitHubRef[], GitHubApiError>
  readonly listLabels: (token: string, owner: string, repo: string) => Effect.Effect<string[], GitHubApiError>
  readonly createPullRequest: (token: string, params: CreatePRParams) => Effect.Effect<PullRequestResult, GitHubApiError>
  readonly addLabels: (token: string, owner: string, repo: string, prNumber: number, labels: string[]) => Effect.Effect<void, GitHubApiError>
}

export class GitHubClient extends Context.Tag("GitHubClient")<GitHubClient, GitHubClientShape>() {}
