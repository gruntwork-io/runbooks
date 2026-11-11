/**
 * Whether a <GitHubPullRequest> block with `allowMerge` can merge its pull
 * request, and with which method, from what GitHub says about the pull
 * request and the repository. GitHub's own rules, branch protection
 * included, decide; this only says what they decided, in words.
 */
import { Effect } from "effect"
import { GitHubApiError } from "../../errors/index.ts"
import { GitHubClient } from "../../services/GitHubClient.ts"
import type {
  MergeMethod,
  PullRequestMergeFacts,
  RepoMergeMethods,
} from "../../services/GitHubClient.ts"

/** Why an open pull request can or can't merge now. */
export type Mergeability = "ready" | "blocked" | "behind" | "conflicts" | "draft" | "checking"

export type MergeState =
  | { readonly state: "merged"; readonly sha?: string }
  | { readonly state: "closed" }
  | {
      readonly state: "open"
      readonly mergeability: Mergeability
      /** The method a merge uses: the first the repository allows, in GitHub's order. */
      readonly method?: MergeMethod
      /** Why it can't merge now, fit to show the user. */
      readonly reason?: string
    }

const METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"]

const REASONS: Record<Exclude<Mergeability, "ready">, string> = {
  blocked: "GitHub's branch protection blocks the merge until a required review or check passes.",
  behind:
    "The base branch has moved on, and branch protection needs the pull request up to date with it. Update the branch on GitHub.",
  conflicts: "It conflicts with the base branch. Resolve the conflicts on GitHub.",
  draft: "It's a draft. Mark it ready for review on GitHub to merge it.",
  checking: "GitHub is still working out whether it can merge.",
}

function mergeability(facts: PullRequestMergeFacts): Mergeability {
  if (facts.draft || facts.mergeableState === "draft") return "draft"
  switch (facts.mergeableState) {
    // `unstable` is a failing check that isn't required, which doesn't stop a merge.
    case "clean":
    case "unstable":
    case "has_hooks":
      return facts.mergeable === false ? "conflicts" : "ready"
    case "blocked":
      return "blocked"
    case "behind":
      return "behind"
    case "dirty":
      return "conflicts"
    default:
      return "checking"
  }
}

export function mergeStateOf(facts: PullRequestMergeFacts, methods: RepoMergeMethods): MergeState {
  if (facts.merged) {
    return facts.mergeCommitSha
      ? { state: "merged", sha: facts.mergeCommitSha }
      : { state: "merged" }
  }
  if (facts.state === "closed") return { state: "closed" }
  const method = METHODS.find((m) => methods[m])
  const found = mergeability(facts)
  if (!method) {
    return {
      state: "open",
      mergeability: "blocked",
      reason: "The repository allows no merge method.",
    }
  }
  return found === "ready"
    ? { state: "open", mergeability: found, method }
    : { state: "open", mergeability: found, method, reason: REASONS[found] }
}

export interface PullRequestRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly host?: string
}

/** Whether the pull request can merge now, as GitHub says. */
export const pullRequestMergeState = (token: string, pr: PullRequestRef) =>
  Effect.gen(function* () {
    const gh = yield* GitHubClient
    const [facts, methods] = yield* Effect.all(
      [
        gh.getPullRequestMergeFacts(token, pr.owner, pr.repo, pr.number, pr.host),
        gh.getRepoMergeMethods(token, pr.owner, pr.repo, pr.host),
      ],
      { concurrency: 2 },
    )
    return mergeStateOf(facts, methods)
  })

/** Merges the pull request with the method GitHub says it can merge with now. */
export const mergeGitHubPullRequest = (token: string, pr: PullRequestRef) =>
  Effect.gen(function* () {
    const current = yield* pullRequestMergeState(token, pr)
    if (current.state === "merged") return { sha: current.sha ?? "" }
    if (current.state === "closed")
      return yield* new GitHubApiError({ status: 0, message: "The pull request is closed." })
    if (current.mergeability !== "ready" || !current.method) {
      return yield* new GitHubApiError({
        status: 0,
        message: current.reason ?? "GitHub can't merge it yet.",
      })
    }
    const gh = yield* GitHubClient
    return yield* gh.mergePullRequest(token, pr.owner, pr.repo, pr.number, current.method, pr.host)
  })
