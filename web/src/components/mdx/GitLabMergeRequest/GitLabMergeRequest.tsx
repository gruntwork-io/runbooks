import { GitPullRequest } from '@/components/mdx/GitPullRequest'
import type { GitLabMergeRequestProps } from '@/components/mdx/GitPullRequest/types'

/**
 * <GitLabMergeRequest> block — a GitLab-locked alias of the generic
 * <GitPullRequest> block, equivalent to
 * `<GitPullRequest provider="gitlab" hideProviderSelect />`. It renders with
 * Merge Request terminology and defaults the title to "Create Merge Request".
 * The internal `__registryType` keeps its duplicate-id, telemetry, and
 * error-message identity reporting as "GitLabMergeRequest".
 */
export function GitLabMergeRequest(props: GitLabMergeRequestProps) {
  return (
    <GitPullRequest
      {...props}
      title={props.title ?? 'Create Merge Request'}
      provider="gitlab"
      hideProviderSelect
      __registryType="GitLabMergeRequest"
    />
  )
}

GitLabMergeRequest.displayName = 'GitLabMergeRequest'

export default GitLabMergeRequest
