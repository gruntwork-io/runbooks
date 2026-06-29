import type { ProviderConfig } from './index'
import { GitHubLogo } from '../components/GitHubLogo'

// Brief descriptions for common GitHub scopes (shown on the success card).
const GITHUB_SCOPE_DESCRIPTIONS: Record<string, string> = {
  'repo': 'Full access to repositories',
  'repo:status': 'Access commit statuses',
  'repo_deployment': 'Access deployment statuses',
  'public_repo': 'Access public repositories only',
  'repo:invite': 'Accept/decline repo invitations',
  'security_events': 'Read/write security events',
  'admin:repo_hook': 'Full control of repository hooks',
  'write:repo_hook': 'Write repository hooks',
  'read:repo_hook': 'Read repository hooks',
  'admin:org': 'Full control of orgs and teams',
  'write:org': 'Read/write org membership',
  'read:org': 'Read org membership',
  'admin:public_key': 'Full control of public keys',
  'write:public_key': 'Write public keys',
  'read:public_key': 'Read public keys',
  'admin:org_hook': 'Full control of organization hooks',
  'gist': 'Create gists',
  'notifications': 'Access notifications',
  'user': 'Read/write user profile',
  'read:user': 'Read user profile',
  'user:email': 'Access user email',
  'user:follow': 'Follow/unfollow users',
  'project': 'Read/write projects',
  'read:project': 'Read projects',
  'delete_repo': 'Delete repositories',
  'write:packages': 'Upload packages',
  'read:packages': 'Download packages',
  'delete:packages': 'Delete packages',
  'admin:gpg_key': 'Full control of GPG keys',
  'write:gpg_key': 'Write GPG keys',
  'read:gpg_key': 'Read GPG keys',
  'codespace': 'Full control of codespaces',
  'workflow': 'Update GitHub Actions workflows',
}

export const githubProviderConfig: ProviderConfig = {
  id: 'github',
  label: 'GitHub',
  Logo: GitHubLogo,
  supportsOAuth: true,
  manualMethods: ['oauth', 'pat'],
  channels: {
    validate: 'github:validate',
    envCredentials: 'github:env-credentials',
    cliCredentials: 'github:cli-credentials',
  },
  env: {
    tokenVar: 'GITHUB_TOKEN',
    userVar: 'GITHUB_USER',
    altTokenVars: ['GH_TOKEN'],
  },
  pat: {
    placeholder: 'github_pat_... or ghp_...',
    prefixHint:
      'Fine-grained tokens start with github_pat_, classic tokens with ghp_',
    tokenCreateUrl: 'https://github.com/settings/personal-access-tokens/new',
    setupGuide: 'github',
  },
  success: {
    scopesDocsUrl:
      'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes',
    scopeDescriptions: GITHUB_SCOPE_DESCRIPTIONS,
    showScopeWarning: true,
    requiredScope: 'repo',
    showAppInstallBranch: true,
    showFineGrainedNote: true,
    unknownTokenLabel: 'Token',
  },
  cli: { label: 'GitHub CLI', loginCmd: 'gh auth login', binary: 'gh' },
  defaultOAuthScopes: ['repo'],
  defaultInstructionScopes: ['repo'],
}
