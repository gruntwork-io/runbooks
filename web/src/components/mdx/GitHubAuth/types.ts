export type GitHubAuthMethod = 'token' | 'device' | 'env'
export type GitHubAuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed'
export type GitHubPrefillStatus = 'pending' | 'success' | 'failed' | 'not-configured'

// GitHub user info returned after authentication
export interface GitHubUser {
  login: string
  name: string | null
  avatarUrl: string
  email: string | null
}

// Props for the GitHubAuth component
export interface GitHubAuthProps {
  id: string
  title?: string
  description?: string
  /** OAuth scopes needed (default: ['repo']) */
  scopes?: string[]
}

// Device flow response from GitHub
export interface DeviceFlowResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}
