import { GitHubLogo } from "@/components/mdx/GitAuth/components/GitHubLogo"
import type { PRProviderConfig } from "./index"

/** GitHub pull-request configuration. */
export const githubPRProviderConfig: PRProviderConfig = {
  id: 'github',
  label: 'GitHub',
  Logo: GitHubLogo,
  noun: { singular: 'Pull Request', abbrev: 'PR', lower: 'pull request' },
  refSymbol: '#',
  defaultTitle: 'Create Pull Request',
  channels: {
    create: 'git:pull-request',
    labels: 'github:labels',
    push: 'git:push',
    deleteBranch: 'git:delete-branch',
  },
  env: {
    tokenVar: 'GITHUB_TOKEN',
    altTokenVars: ['GH_TOKEN'],
  },
  instruction: {
    cliTitle: 'Open a pull request:',
    build: 'gh',
  },
  supportsPushMore: true,
}
