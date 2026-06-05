import { GitHubAuth } from './GitHubAuth'

export { GitHubAuth }
export default GitHubAuth

// GitHubAuth is now a thin alias of <GitAuth>; the types live in the GitAuth
// module. Re-export the GitHub* aliases here so existing importers of
// `@/components/mdx/GitHubAuth` keep working unchanged.
export type {
  GitHubAuthProps,
  GitHubAuthMethod,
  GitHubAuthStatus,
  GitHubDetectionStatus,
  GitHubCredentialSource,
  GitHubDetectionSource,
  GitHubTokenType,
  GitHubUserInfo,
  GitHubCredentials,
  GitHubCliCredentialsResponse,
} from '@/components/mdx/GitAuth/types'

export { isCliAuthFound, hasRepoScope } from '@/components/mdx/GitAuth/types'
