/**
 * Where a <TfApplyWithGitHubPullRequest> block stands: one stage, worked out
 * from its pull request and its Terragrunt run, so every tab agrees on what
 * comes next and when the block is done.
 */

import type { PullRequestStatus } from "./prMachine"

export type Tab = "code" | "pr" | "apply"

/** What the block knows about each part of its work. */
export interface FlowFacts {
  /** Whether there's a repository to open a pull request in. */
  readonly hasRepo: boolean
  /** The pull request, for the inputs as they are now. */
  readonly pr: PullRequestStatus
  /** Whether the infrastructure matches the inputs as they are now. */
  readonly applied: boolean
}

export type Stage =
  /** The inputs are ready and nobody has opened a pull request. */
  | "open-pr"
  /** The pull request is open, but the inputs changed since its last push. */
  | "push"
  /** The pull request is open and nothing is applied: merge first or apply first. */
  | "merge-or-apply"
  /** It's applied, and the pull request still needs merging. */
  | "merge"
  /** It's merged, or there's no repository, and it still needs applying. */
  | "apply"
  /** Merged and applied, or applied when there's no repository. */
  | "done"

export function stageOf(facts: FlowFacts): Stage {
  if (facts.hasRepo) {
    // A merged pull request with other inputs needs a new one, as if there were none.
    if (facts.pr === "none" || facts.pr === "superseded") return "open-pr"
    if (facts.pr === "behind") return "push"
    if (facts.pr === "open") return facts.applied ? "merge" : "merge-or-apply"
  }
  return facts.applied ? "done" : "apply"
}

/** The tab where the stage's next step happens. */
export function tabFor(stage: Stage): Tab {
  switch (stage) {
    case "open-pr":
    case "push":
    case "merge-or-apply":
    case "merge":
      return "pr"
    case "apply":
    case "done":
      return "apply"
  }
}

const LABELS: Record<Stage, string> = {
  "open-pr": "Open the pull request",
  push: "Push the changes",
  "merge-or-apply": "Merge or apply",
  merge: "Merge the pull request",
  apply: "Apply",
  done: "Done",
}

/** A step on another tab, and the words on the button that goes there. */
export interface NextStep {
  readonly tab: Tab
  readonly label: string
}

/**
 * Where a tab's Next button leads, and what it says, or nothing when the next
 * step is on that tab. Code leads on to PR, or to Apply when there's no
 * repository; PR and Apply lead to the tab where the next step is.
 */
export function nextFrom(tab: Tab, stage: Stage, hasRepo: boolean): NextStep | undefined {
  if (tab === "code") return { tab: hasRepo ? "pr" : "apply", label: "Next" }
  // Either order works here, so both tabs have a step of their own.
  if (stage === "merge-or-apply" || stage === "done") return undefined
  const target = tabFor(stage)
  return target === tab ? undefined : { tab: target, label: LABELS[stage] }
}
