import { GitPullRequest } from '@/components/mdx/GitPullRequest'
import type { GitHubPullRequestProps } from '@/components/mdx/GitPullRequest/types'

/**
 * Backward-compatible <GitHubPullRequest> block.
 *
 * GitHubPullRequest is now a GitHub-locked alias of the generic
 * <GitPullRequest> block — equivalent to
 * `<GitPullRequest provider="github" hideProviderSelect />`. It keeps its
 * existing props (including `githubAuthId`) and default title, so existing
 * runbooks behave exactly as before. The internal `__registryType` keeps its
 * duplicate-id, telemetry, and error-message identity reporting as
 * "GitHubPullRequest".
 */
export function GitHubPullRequest(props: GitHubPullRequestProps) {
  return (
    <GitPullRequest
      {...props}
      // Preserve the legacy default title; the generic block defaults per
      // provider ("Create Pull Request" for github), so this matches.
      title={props.title ?? 'Create Pull Request'}
      provider="github"
      hideProviderSelect
      __registryType="GitHubPullRequest"
    />
  )
}

GitHubPullRequest.displayName = 'GitHubPullRequest'

export default GitHubPullRequest
