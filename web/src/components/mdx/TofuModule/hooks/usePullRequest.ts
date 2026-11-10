import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { MergeMethod } from "../../../../../../src/services/GitHubClient"
import type { LogLine } from "./useTofuRun"

export interface PullRequestTarget {
  /** The repository's checkout in the session; none in simulation. */
  readonly worktreePath?: string | undefined
  readonly owner: string
  readonly repo: string
  readonly baseBranch: string
}

/** What the person wrote for the pull request. */
export interface PullRequestDraft {
  readonly title: string
  readonly branch: string
  readonly body: string
}

export interface PullRequestState {
  readonly phase: "draft" | "opening" | "open" | "pushing" | "merging" | "merged"
  readonly log: readonly LogLine[]
  readonly pr?: { readonly url: string; readonly number: number; readonly branch: string }
  readonly title?: string
  /** The inputs the branch has, as JSON, so a change shows it needs a push. */
  readonly pushedWith?: string
  readonly error?: string | undefined
}

const message = (err: unknown) =>
  cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

let runSeq = 0

/**
 * Opens, updates, and merges the pull request that adds a block's Terragrunt
 * unit to the cloned repository, and keeps what the PR tab shows.
 */
export function usePullRequest(
  blockId: string,
  source: string,
  values: Record<string, unknown>,
  path: string,
) {
  const api = useApi()
  const [state, setState] = useState<PullRequestState>({ phase: "draft", log: [] })
  const unsubscribe = useRef<(() => void) | null>(null)

  const start = useCallback(() => {
    const id = `${blockId}-pr-${++runSeq}`
    unsubscribe.current?.()
    unsubscribe.current = api.on("tofu-module:event", ({ runId, event }) => {
      if (runId !== id || event.kind !== "log") return
      setState((prev) => ({
        ...prev,
        log: [...prev.log, { line: event.line, level: event.level }],
      }))
    })
    return id
  }, [api, blockId])

  useEffect(() => () => unsubscribe.current?.(), [])

  const unit = { blockId, source, values, path }

  const open = async (target: PullRequestTarget, draft: PullRequestDraft) => {
    const runId = start()
    const pushedWith = JSON.stringify(values)
    setState({ phase: "opening", log: [] })
    try {
      const pr = await api.invoke("tofu-module:pr-open", {
        ...unit,
        runId,
        target,
        branch: draft.branch,
        title: draft.title,
        body: draft.body,
        commitMessage: draft.title,
      })
      setState((prev) => ({ ...prev, phase: "open", pr, title: draft.title, pushedWith }))
    } catch (err) {
      setState((prev) => ({ ...prev, phase: "draft", error: message(err) }))
    }
  }

  const push = async (target: PullRequestTarget) => {
    const { pr, title } = state
    if (!pr || !title) return
    const runId = start()
    const pushedWith = JSON.stringify(values)
    setState((prev) => ({ ...prev, phase: "pushing", error: undefined }))
    try {
      await api.invoke("tofu-module:pr-push", {
        ...unit,
        runId,
        target,
        branch: pr.branch,
        title,
        commitMessage: `Update ${title}`,
      })
      setState((prev) => ({ ...prev, phase: "open", pushedWith }))
    } catch (err) {
      setState((prev) => ({ ...prev, phase: "open", error: message(err) }))
    }
  }

  const merge = async (target: PullRequestTarget, method: MergeMethod) => {
    const { pr } = state
    if (!pr) return
    const runId = start()
    setState((prev) => ({ ...prev, phase: "merging", error: undefined }))
    try {
      await api.invoke("tofu-module:pr-merge", {
        runId,
        blockId,
        target,
        number: pr.number,
        method,
      })
      setState((prev) => ({ ...prev, phase: "merged" }))
    } catch (err) {
      setState((prev) => ({ ...prev, phase: "open", error: message(err) }))
    }
  }

  const behind = state.pushedWith !== undefined && state.pushedWith !== JSON.stringify(values)

  return { state, open, push, merge, behind }
}
