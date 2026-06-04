import { GitAuth } from '@/components/mdx/GitAuth'
import type { GitLabAuthProps } from '@/components/mdx/GitAuth/types'

/**
 * <GitLabAuth> block.
 *
 * A GitLab-locked alias of the generic <GitAuth> block — equivalent to
 * `<GitAuth provider="gitlab" hideProviderSelect />`. It renders with no
 * provider picker and authenticates to GitLab only. The internal
 * `__registryType` keeps its duplicate-id, telemetry, and error-message
 * identity reporting as "GitLabAuth".
 */
export function GitLabAuth(props: GitLabAuthProps) {
  return (
    <GitAuth
      {...props}
      title={props.title ?? 'GitLab Authentication'}
      provider="gitlab"
      hideProviderSelect
      __registryType="GitLabAuth"
    />
  )
}

GitLabAuth.displayName = 'GitLabAuth'
