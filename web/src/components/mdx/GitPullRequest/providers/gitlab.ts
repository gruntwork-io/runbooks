import { GitLabLogo } from "@/components/mdx/GitAuth/components/GitLabLogo"
import type { PRProviderConfig } from "./index"

/** GitLab merge-request configuration. */
export const gitlabPRProviderConfig: PRProviderConfig = {
  id: 'gitlab',
  label: 'GitLab',
  Logo: GitLabLogo,
  noun: { singular: 'Merge Request', abbrev: 'MR', lower: 'merge request' },
  refSymbol: '!',
  defaultTitle: 'Create Merge Request',
  channels: {
    create: 'git:merge-request',
    labels: 'gitlab:labels',
    push: 'git:push',
    deleteBranch: 'git:delete-branch',
  },
  env: {
    // glab and the Runbooks backend use GITLAB_TOKEN only (no GL_TOKEN).
    tokenVar: 'GITLAB_TOKEN',
    altTokenVars: [],
  },
  instruction: {
    cliTitle: 'Open a merge request:',
    build: 'glab',
  },
}
