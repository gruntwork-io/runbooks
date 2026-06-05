import type { FC } from 'react'
import type { GitAuthMethod, GitProvider } from '../types'
import { githubProviderConfig } from './github'
import { gitlabProviderConfig } from './gitlab'

export type { GitProvider } from '../types'

export interface LogoProps {
  className?: string
  ariaLabel?: string
}

/**
 * Everything provider-specific about the Git auth block lives here, so the
 * shared hook and UI components stay provider-agnostic. Adding a new provider
 * is a matter of adding a config entry (plus its backend handlers).
 */
export interface ProviderConfig {
  id: GitProvider
  /** Display name: "GitHub" / "GitLab". */
  label: string
  Logo: FC<LogoProps>
  /** Whether the OAuth device flow is available (GitHub only). */
  supportsOAuth: boolean
  /** Manual auth method tabs shown to the user (in order). */
  manualMethods: GitAuthMethod[]

  /** IPC channels for this provider. */
  channels: {
    validate: 'github:validate' | 'gitlab:validate'
    envCredentials: 'github:env-credentials' | 'gitlab:env-credentials'
    cliCredentials: 'github:cli-credentials' | 'gitlab:cli-credentials'
    /** Enumerate available hosts for the host picker (GitLab only). */
    enumerateHosts?: 'gitlab:enumerate-hosts'
  }
  /**
   * Whether this provider supports choosing among multiple hosts/instances
   * (GitLab self-managed vs gitlab.com). GitHub is single-host here, so false.
   */
  supportsHostSelection?: boolean
  /** Session/output env var names this provider writes. */
  env: {
    tokenVar: 'GITHUB_TOKEN' | 'GITLAB_TOKEN'
    userVar: 'GITHUB_USER' | 'GITLAB_USER'
    /** Alternate token env vars (used for block-output detection). */
    altTokenVars: string[]
  }
  /** Personal access token form copy. */
  pat: {
    placeholder: string
    prefixHint: string | null
    tokenCreateUrl: string
    setupGuide: 'github' | 'gitlab'
  }
  /** Success-card behavior. */
  success: {
    scopesDocsUrl: string
    scopeDescriptions: Record<string, string>
    showScopeWarning: boolean
    requiredScope?: string
    /**
     * Scopes that each satisfy the requirement (any-of). Used when several
     * scopes grant the needed access — e.g. GitLab's `api` is a superset of
     * `write_repository`. Defaults to `[requiredScope]` when omitted.
     */
    acceptableScopes?: string[]
    showAppInstallBranch: boolean
    showFineGrainedNote: boolean
    /** Label shown for an unrecognized token type. */
    unknownTokenLabel: string
  }
  /** CLI auto-detection copy. */
  cli: { label: string; loginCmd: string }
  defaultOAuthScopes: string[]
  defaultInstructionScopes: string[]
}

export const PROVIDERS: Record<GitProvider, ProviderConfig> = {
  github: githubProviderConfig,
  gitlab: gitlabProviderConfig,
}
