/**
 * Pure pieces of the git:pull-request / git:merge-request response, kept out
 * of git.ts so they can be tested without an Electron runtime.
 */

/**
 * Block outputs for GitPullRequest (and its GitHubPullRequest /
 * GitLabMergeRequest wrappers). The names are the documented contract
 * (docs/src/content/docs/authoring/blocks/GitPullRequest.mdx and
 * GitHubPullRequest.mdx) that runbooks reference as
 * `{{ .outputs.<id>.PR_URL }}`. Output lookup is case-sensitive, so these must
 * not drift. For GitLab, `PR_ID` is the merge request iid.
 */
export function prBlockOutputs(pr: { url: string; number: number }): Record<string, string> {
  return { PR_ID: String(pr.number), PR_URL: pr.url }
}

/**
 * Whether a PR/MR run failed because `git checkout -b` found an existing local
 * branch with the head branch's name. That is the one conflict the renderer's
 * delete-branch recovery can fix. Remote conflicts (GitHub's "A pull request
 * already exists", GitLab's HTTP 409) are not: deleting a local branch removes
 * neither the remote branch nor the open PR/MR.
 */
export function isLocalBranchConflict(message: string): boolean {
  return /a branch named .* already exists/i.test(message)
}
