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
  // Backward-compatible GitHub* alias
  GitHubAuthProps,
} from './types'

export { isCliAuthFound } from './types'
