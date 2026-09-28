/**
 * The block types `runbooks test` knows about.
 *
 * This module has no imports so the web test suite can load it:
 * web/src/components/mdx/__tests__/blockCliCoverage.test.ts fails when this
 * list and the app's MDX_COMPONENTS registry disagree, so a new block can't
 * ship without the test runner at least recognizing it.
 */

/** Every block the app registers (MDX_COMPONENTS, minus element overrides). */
export const BLOCK_TYPES = [
  "Check",
  "Command",
  "Inputs",
  "Template",
  "TemplateInline",
  "AwsAuth",
  "GoogleAuth",
  "GitAuth",
  "GitHubAuth",
  "GitLabAuth",
  "GitClone",
  "GitPullRequest",
  "GitHubPullRequest",
  "GitLabMergeRequest",
  "DirPicker",
  "Admonition",
] as const

/** Blocks that authenticate and inject credentials for the blocks that reference them. */
export const AUTH_BLOCK_TYPES = ["AwsAuth", "GoogleAuth", "GitAuth", "GitHubAuth", "GitLabAuth"] as const

/**
 * Blocks that push a branch and open a pull/merge request. Test mode never
 * runs them, so they can only be tested with `expect: skip`.
 */
export const PR_BLOCK_TYPES = ["GitPullRequest", "GitHubPullRequest", "GitLabMergeRequest"] as const
