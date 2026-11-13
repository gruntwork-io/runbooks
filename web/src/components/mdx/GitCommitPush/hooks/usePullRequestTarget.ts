import { usePageBlocks, type PullRequestPlace } from "@/contexts/ComponentIdRegistry"
import { useAllOutputs } from "@/contexts/useRunbook"
import { revealOutputs } from "@/lib/outputValues"
import { normalizeBlockId } from "@/lib/utils"
import type { AppError } from "@/types/error"

const PULL_REQUEST_BLOCKS = new Set(["GitPullRequest", "GitHubPullRequest", "GitLabMergeRequest"])

/** The open pull request, as its block's outputs give it. */
export interface OpenPullRequest {
  readonly number: number
  readonly url: string
  readonly branch: string
}

export interface PullRequestTarget {
  /** Where the pull request block works, once it has registered. */
  readonly place?: PullRequestPlace
  /** The pull request, once the block has opened it. */
  readonly pr?: OpenPullRequest
  readonly error: AppError | null
}

/** The pull request block `pullRequestId` names, and its pull request once it's open. */
export function usePullRequestTarget(
  pullRequestId: string | undefined,
  block: string,
): PullRequestTarget {
  const { blockOf, registered } = usePageBlocks()
  const outputs = useAllOutputs()
  if (!pullRequestId || !registered) return { error: null }

  const target = blockOf(pullRequestId)
  if (!target || !PULL_REQUEST_BLOCKS.has(target.kind)) {
    return {
      error: {
        message: `The ${block} block's pullRequestId names "${pullRequestId}", which isn't a pull request block in this runbook.`,
        details:
          "Set pullRequestId to the id of a <GitPullRequest>, <GitHubPullRequest> or <GitLabMergeRequest> block.",
      },
    }
  }

  const values: Partial<Record<string, string>> = revealOutputs(
    outputs[normalizeBlockId(pullRequestId)]?.values ?? {},
  )
  const number = Number(values.PR_ID)
  const pr =
    values.PR_URL && values.BRANCH && Number.isInteger(number)
      ? { number, url: values.PR_URL, branch: values.BRANCH }
      : undefined
  return {
    ...(target.pullRequest ? { place: target.pullRequest } : {}),
    ...(pr ? { pr } : {}),
    error: null,
  }
}
