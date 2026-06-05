/**
 * Provider derivation helpers shared by Git blocks (GitPullRequest, GitClone).
 *
 * The central rule: a downstream block learns which provider it's talking to
 * from the LINKED AUTH BLOCK, not from the remote hostname. Self-hosted
 * GitHub/GitLab instances live on arbitrary hosts, so the host tells us nothing
 * about which credential or API to use — the auth block (which writes a
 * GIT_PROVIDER output) does.
 */
import type { GitProvider } from "@/components/mdx/GitAuth/types"
import type { BlockOutputs } from "@/contexts/RunbookContext"
import { normalizeBlockId } from "@/lib/utils"

export type { GitProvider }

/**
 * Derive the provider of a linked auth block from its registered outputs:
 *   1. the explicit `GIT_PROVIDER` output written by the GitAuth block;
 *   2. failing that, the presence of a provider token var (GITHUB_TOKEN ->
 *      github, GITLAB_TOKEN -> gitlab) for blocks authenticated before
 *      GIT_PROVIDER existed.
 *
 * Returns `undefined` when not derivable (no link, or the auth block hasn't
 * resolved yet). Callers MUST treat `undefined` as "unknown" — never as a
 * mismatch — so a not-yet-authenticated link doesn't trip the wrong-provider
 * guard.
 */
export function deriveProviderFromAuth(
  authId: string | undefined,
  allOutputs: Record<string, BlockOutputs>,
): GitProvider | undefined {
  if (!authId) return undefined
  const values = allOutputs[normalizeBlockId(authId)]?.values
  if (!values) return undefined
  const explicit = values.GIT_PROVIDER
  if (explicit === 'github' || explicit === 'gitlab') return explicit
  if (values.GITHUB_TOKEN) return 'github'
  if (values.GITLAB_TOKEN) return 'gitlab'
  return undefined
}

function hostOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`).hostname
  } catch {
    const ssh = rawUrl.match(/^git@([^:]+):/)
    return ssh ? ssh[1] : undefined
  }
}

/**
 * Best-effort provider guess from a clone URL's host. Only the public SaaS
 * hosts (github.com / gitlab.com) are recognized; self-hosted/Enterprise hosts
 * return `undefined` (we can't tell GitHub Enterprise from GitLab self-managed
 * by hostname). Used ONLY as a last-resort default for the generic block's
 * displayed provider — NEVER to gate the wrong-auth-block error.
 */
export function deriveProviderFromRepoUrl(
  repoUrl: string | undefined,
): GitProvider | undefined {
  if (!repoUrl) return undefined
  const host = hostOf(repoUrl)
  if (host === 'github.com') return 'github'
  if (host === 'gitlab.com') return 'gitlab'
  return undefined
}
