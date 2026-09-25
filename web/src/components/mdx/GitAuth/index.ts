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
  // Backward-compatible GitHub* alias
  GitHubAuthProps,
} from './types'
