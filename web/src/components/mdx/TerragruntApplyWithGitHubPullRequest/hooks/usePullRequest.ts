import { useEffect, useReducer, useRef } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { MergeMethod } from "../../../../../../src/services/GitHubClient"
import type { TfModuleCodeRef } from "../../../../../../electron/shared/channels"
import { inputsKey } from "../../../../../../src/domain/tf-module/inputsKey"
import {
  INITIAL_PULL_REQUEST,
  pullRequestReducer,
  pullRequestStatus,
  type PullRequestTask,
} from "../prMachine"

export interface PullRequestTarget {
  /** The repository's checkout in the session. */
  readonly worktreePath?: string | undefined
  readonly owner: string
  readonly repo: string
  readonly baseBranch: string
}

/** What the person wrote for the pull request. */
export interface PullRequestDraft {
  readonly title: string
  readonly commitMessage: string
  readonly branch: string
  readonly body: string
}

const message = (err: unknown) =>
  cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

let runSeq = 0

/**
 * Opens, updates, and merges the pull request that adds a block's Terragrunt
 * unit to the cloned repository, keeping its state (see prMachine) and what
 * it means for the inputs as they are now.
 */
export function usePullRequest(
  blockId: string,
  module: TfModuleCodeRef,
  values: Record<string, unknown>,
  path: string,
) {
  const api = useApi()
  const [state, dispatch] = useReducer(pullRequestReducer, INITIAL_PULL_REQUEST)
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(() => () => unsubscribe.current?.(), [])

  /** A run id whose git log lines go to the PR tab's log. */
  const logged = () => {
    const id = `${blockId}-pr-${++runSeq}`
    unsubscribe.current?.()
    unsubscribe.current = api.on("tf-module:event", ({ runId, event, at }) => {
      if (runId === id && event.kind === "log") {
        dispatch({ type: "log", line: { line: event.line, level: event.level, at } })
      }
    })
    return id
  }

  const unit = { ...module, blockId, values, path }
  const { phase } = state
  const pr = phase.kind === "open" ? phase.pr : undefined

  const open = async (target: PullRequestTarget, draft: PullRequestDraft) => {
    dispatch({ type: "open-started" })
    const inputs = inputsKey(values)
    try {
      const opened = await api.invoke("tf-module:pr-open", {
        ...unit,
        runId: logged(),
        target,
        branch: draft.branch,
        title: draft.title,
        body: draft.body,
        commitMessage: draft.commitMessage,
      })
      dispatch({ type: "opened", pr: { ...opened, title: draft.title, body: draft.body }, inputs })
    } catch (err) {
      dispatch({ type: "failed", error: message(err) })
    }
  }

  /** Runs a task on the open pull request; true when it worked. */
  const task = async (name: PullRequestTask, call: (runId: string) => Promise<unknown>) => {
    dispatch({ type: "task-started", task: name })
    try {
      await call(logged())
      return true
    } catch (err) {
      dispatch({ type: "failed", error: message(err) })
      return false
    }
  }

  const push = async (target: PullRequestTarget) => {
    if (!pr) return
    const inputs = inputsKey(values)
    const ok = await task("pushing", (runId) =>
      api.invoke("tf-module:pr-push", {
        ...unit,
        runId,
        target,
        branch: pr.branch,
        title: pr.title,
        commitMessage: `Update ${pr.title}`,
      }),
    )
    if (ok) dispatch({ type: "pushed", inputs })
  }

  const update = async (target: PullRequestTarget, changes: { title: string; body: string }) => {
    if (!pr) return false
    const ok = await task("updating", (runId) =>
      api.invoke("tf-module:pr-update", { runId, blockId, target, number: pr.number, ...changes }),
    )
    if (ok) dispatch({ type: "updated", ...changes })
    return ok
  }

  const merge = async (target: PullRequestTarget, method: MergeMethod) => {
    if (!pr) return
    const ok = await task("merging", (runId) =>
      api.invoke("tf-module:pr-merge", { runId, blockId, target, number: pr.number, method }),
    )
    if (ok) dispatch({ type: "merged" })
  }

  const startNew = () => dispatch({ type: "start-new" })

  return {
    state,
    status: pullRequestStatus(phase, inputsKey(values)),
    open,
    push,
    update,
    merge,
    startNew,
  }
}
