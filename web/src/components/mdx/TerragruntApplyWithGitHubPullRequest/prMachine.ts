/**
 * The life of a block's pull request, as one state machine: a draft, the
 * open pull request and what's being done to it, and the merged one. Every
 * pull request remembers the inputs its branch has, so a change to them shows
 * it needs a push, or, once merged, a new pull request. Pure, so the
 * transitions are tested without GitHub.
 */
import type { LogLine } from "./runMachine"

export interface OpenedPullRequest {
  readonly url: string
  readonly number: number
  readonly branch: string
  readonly title: string
  readonly body: string
}

/** What's being done to an open pull request. */
export type PullRequestTask = "pushing" | "updating" | "merging"

export type PullRequestPhase =
  | { readonly kind: "draft"; readonly error?: string | undefined }
  | { readonly kind: "opening" }
  | {
      readonly kind: "open"
      readonly pr: OpenedPullRequest
      /** The inputs the branch has. */
      readonly pushedWith: string
      readonly task?: PullRequestTask | undefined
      readonly error?: string | undefined
    }
  | { readonly kind: "merged"; readonly pr: OpenedPullRequest; readonly mergedWith: string }

export interface PullRequestState {
  readonly phase: PullRequestPhase
  /** Pull requests this block merged before the current one, oldest first. */
  readonly merged: readonly OpenedPullRequest[]
  readonly log: readonly LogLine[]
}

export type PullRequestAction =
  | { readonly type: "open-started" }
  | { readonly type: "opened"; readonly pr: OpenedPullRequest; readonly inputs: string }
  | { readonly type: "task-started"; readonly task: PullRequestTask }
  | { readonly type: "pushed"; readonly inputs: string }
  | { readonly type: "updated"; readonly title: string; readonly body: string }
  | { readonly type: "merged" }
  | { readonly type: "failed"; readonly error: string }
  /** Starts a new pull request after a merge, for inputs that changed since. */
  | { readonly type: "start-new" }
  | { readonly type: "log"; readonly line: LogLine }

export const INITIAL_PULL_REQUEST: PullRequestState = {
  phase: { kind: "draft" },
  merged: [],
  log: [],
}

export function pullRequestReducer(
  state: PullRequestState,
  action: PullRequestAction,
): PullRequestState {
  const { phase } = state
  switch (action.type) {
    case "open-started":
      if (phase.kind !== "draft") return state
      return { ...state, phase: { kind: "opening" }, log: [] }
    case "opened":
      if (phase.kind !== "opening") return state
      return { ...state, phase: { kind: "open", pr: action.pr, pushedWith: action.inputs } }
    case "task-started":
      if (phase.kind !== "open" || phase.task) return state
      return { ...state, phase: { ...phase, task: action.task, error: undefined } }
    case "pushed":
      if (phase.kind !== "open" || phase.task !== "pushing") return state
      return { ...state, phase: { ...phase, task: undefined, pushedWith: action.inputs } }
    case "updated":
      if (phase.kind !== "open" || phase.task !== "updating") return state
      return {
        ...state,
        phase: {
          ...phase,
          task: undefined,
          pr: { ...phase.pr, title: action.title, body: action.body },
        },
      }
    case "merged":
      if (phase.kind !== "open" || phase.task !== "merging") return state
      return { ...state, phase: { kind: "merged", pr: phase.pr, mergedWith: phase.pushedWith } }
    case "failed":
      if (phase.kind === "opening")
        return { ...state, phase: { kind: "draft", error: action.error } }
      if (phase.kind === "open" && phase.task) {
        return { ...state, phase: { ...phase, task: undefined, error: action.error } }
      }
      return state
    case "start-new":
      if (phase.kind !== "merged") return state
      return { phase: { kind: "draft" }, merged: [...state.merged, phase.pr], log: [] }
    case "log":
      return { ...state, log: [...state.log, action.line] }
  }
}

/**
 * What the pull request means for the inputs as they are now:
 * - `none`: no pull request yet;
 * - `open`: open, and its branch has them;
 * - `behind`: open, and they changed since the last push;
 * - `merged`: merged with them;
 * - `superseded`: merged with other inputs, so the change needs a new pull request.
 */
export type PullRequestStatus = "none" | "open" | "behind" | "merged" | "superseded"

export function pullRequestStatus(phase: PullRequestPhase, inputs: string): PullRequestStatus {
  switch (phase.kind) {
    case "draft":
    case "opening":
      return "none"
    case "open":
      return phase.pushedWith === inputs ? "open" : "behind"
    case "merged":
      return phase.mergedWith === inputs ? "merged" : "superseded"
  }
}

/** A branch name the block hasn't used yet: the draft's, or it with -2, -3, and so on. */
export function unusedBranch(branch: string, used: readonly OpenedPullRequest[]): string {
  const taken = new Set(used.map((pr) => pr.branch))
  if (!taken.has(branch)) return branch
  let n = 2
  while (taken.has(`${branch}-${n}`)) n++
  return `${branch}-${n}`
}
