import { GitHubAuth } from './GitHubAuth'

export { GitHubAuth }
export default GitHubAuth

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
} from './types'

export { isCliAuthFound, hasRepoScope } from './types'
