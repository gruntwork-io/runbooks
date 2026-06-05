import type { FC } from "react"
import type { GitProvider } from "@/components/mdx/GitAuth/types"
import type { LogoProps } from "@/components/mdx/GitAuth/providers"
import { githubPRProviderConfig } from "./github"
import { gitlabPRProviderConfig } from "./gitlab"

export type { GitProvider }

/**
 * Everything provider-specific about the Git PR/MR block lives here, so the
 * shared hook and UI stay provider-agnostic — the same pattern as GitAuth's
 * ProviderConfig. Adding a provider is a config entry (plus its backend
 * handlers + channels).
 */
export interface PRProviderConfig {
  id: GitProvider
  /** Display name: "GitHub" / "GitLab". */
  label: string
  Logo: FC<LogoProps>
  /**
   * The change-request noun, in the forms the UI needs:
   *   - singular: "Pull Request" / "Merge Request"
   *   - abbrev:   "PR" / "MR"
   *   - lower:    "pull request" / "merge request"
   */
  noun: { singular: string; abbrev: string; lower: string }
  /** Display-only ref symbol: GitHub `#42`, GitLab `!42`. */
  refSymbol: '#' | '!'
  /** Default block title when the author doesn't set one. */
  defaultTitle: string
  /** IPC channels this provider's block calls. */
  channels: {
    create: 'git:pull-request' | 'git:merge-request'
    labels: 'github:labels' | 'gitlab:labels'
    push: 'git:push'
    deleteBranch: 'git:delete-branch'
  }
  /** Block-output env var names used to detect a linked auth block's token. */
  env: {
    tokenVar: 'GITHUB_TOKEN' | 'GITLAB_TOKEN'
    /** Alternate token env vars accepted from a linked auth block. */
    altTokenVars: string[]
  }
  /** Instruction-mode CLI rendering. */
  instruction: {
    /** Heading above the copyable command. */
    cliTitle: string
    /** Which command builder to use. */
    build: 'gh' | 'glab'
  }
  /**
   * Whether the post-create "push more changes" button is shown. Both providers
   * support it now that git:push is provider-aware.
   */
  supportsPushMore: boolean
}

export const PR_PROVIDERS: Record<GitProvider, PRProviderConfig> = {
  github: githubPRProviderConfig,
  gitlab: gitlabPRProviderConfig,
}
