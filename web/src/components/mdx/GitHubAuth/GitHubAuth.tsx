import { GitAuth } from '@/components/mdx/GitAuth'
import type { GitHubAuthProps } from '@/components/mdx/GitAuth/types'

/**
 * Backward-compatible <GitHubAuth> block.
 *
 * GitHubAuth is now a GitHub-locked alias of the generic <GitAuth> block —
 * equivalent to `<GitAuth provider="github" hideProviderSelect />`. It renders
 * with no provider picker and behaves exactly as before. The internal
 * `__registryType` keeps its duplicate-id, telemetry, and error-message
 * identity reporting as "GitHubAuth".
 */
export function GitHubAuth(props: GitHubAuthProps) {
  return (
    <GitAuth
      {...props}
      // Preserve the legacy default title ("GitHub Authentication"); the generic
      // <GitAuth> block defaults to "Git Authentication".
      title={props.title ?? 'GitHub Authentication'}
      provider="github"
      hideProviderSelect
      __registryType="GitHubAuth"
    />
  )
}

GitHubAuth.displayName = 'GitHubAuth'
