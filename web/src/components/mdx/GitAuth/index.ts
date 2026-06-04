import { GitAuth } from './GitAuth'

export { GitAuth }
export default GitAuth

export type {
  GitAuthProps,
  GitProvider,
  GitAuthMethod,
  GitAuthStatus,
  GitDetectionStatus,
  GitCredentialSource,
  GitDetectionSource,
  GitTokenType,
  GitUserInfo,
  GitCredentials,
  GitCliCredentialsResponse,
  // Backward-compatible GitHub* aliases
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
