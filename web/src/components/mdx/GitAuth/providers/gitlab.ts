import type { ProviderConfig } from './index'
import { GitLabLogo } from '../components/GitLabLogo'

// GitLab's GET /user exposes no scope header, but scopes are introspected
// separately (/oauth/token/info for OAuth tokens, /personal_access_tokens/self
// for PATs), so the success card shows the token's permissions like GitHub.
const GITLAB_SCOPE_DESCRIPTIONS: Record<string, string> = {
  api: 'Full read/write access to the API.',
  read_api: 'Read access to the API.',
  read_repository: 'Read access to repositories.',
  write_repository: 'Read/write access to repositories.',
  read_user: 'Read access to user profile.',
  openid: 'Authenticate with OpenID Connect.',
  profile: 'Read access to profile information.',
  email: 'Read access to your email address.',
}

export const gitlabProviderConfig: ProviderConfig = {
  id: 'gitlab',
  label: 'GitLab',
  Logo: GitLabLogo,
  // No registered Gruntwork GitLab OAuth app — auth is PAT / CLI / env only.
  supportsOAuth: false,
  manualMethods: ['pat'],
  channels: {
    validate: 'gitlab:validate',
    envCredentials: 'gitlab:env-credentials',
    cliCredentials: 'gitlab:cli-credentials',
  },
  env: {
    tokenVar: 'GITLAB_TOKEN',
    userVar: 'GITLAB_USER',
    // glab and the Runbooks backend use GITLAB_TOKEN only (no GL_TOKEN).
    altTokenVars: [],
  },
  pat: {
    placeholder: 'Your GitLab access token (glpat-...)',
    prefixHint: null,
    tokenCreateUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    setupGuide: 'gitlab',
  },
  success: {
    scopesDocsUrl:
      'https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html#personal-access-token-scopes',
    scopeDescriptions: GITLAB_SCOPE_DESCRIPTIONS,
    // Warn when the token grants no repository write access. `api` is a superset
    // of `write_repository`, so either satisfies the requirement.
    showScopeWarning: true,
    requiredScope: 'write_repository',
    acceptableScopes: ['api', 'write_repository'],
    showAppInstallBranch: false,
    showFineGrainedNote: false,
    unknownTokenLabel: 'Access Token',
  },
  cli: { label: 'glab CLI', loginCmd: 'glab auth login' },
  defaultOAuthScopes: [],
  defaultInstructionScopes: ['read_repository', 'write_repository'],
}
