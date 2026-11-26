import { describe, it, expect } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, waitFor, act } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi } from "@/test/test-api"
import { useCommitsAhead } from "../useCommitsAhead"

function setup(handler: () => { count: number }) {
  const testApi = makeTestApi({ "git:commits-ahead": handler })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ApiProvider, { api: testApi.api }, children)
  return { testApi, wrapper }
}

describe("useCommitsAhead", () => {
  it("asks the main process for the worktree's commits ahead of the base branch", async () => {
    const { testApi, wrapper } = setup(() => ({ count: 4 }))

    const { result } = renderHook(() => useCommitsAhead("/work/infra", "main", 0), { wrapper })

    await waitFor(() => expect(result.current.count).toBe(4))
    expect(testApi.invoke).toHaveBeenCalledWith("git:commits-ahead", {
      worktreePath: "/work/infra",
      baseBranch: "main",
    })
  })

  it("refresh resolves with the fresh count", async () => {
    let count = 0
    const { wrapper } = setup(() => ({ count }))
    const { result } = renderHook(() => useCommitsAhead("/work/infra", "main", 0), { wrapper })
    await waitFor(() => expect(result.current.count).toBe(0))

    count = 2
    let fresh: number | null = null
    await act(async () => {
      fresh = await result.current.refresh()
    })

    expect(fresh).toBe(2)
    expect(result.current.count).toBe(2)
  })

  it("is null without a worktree, and makes no query", async () => {
    const { testApi, wrapper } = setup(() => ({ count: 1 }))

    const { result } = renderHook(() => useCommitsAhead(undefined, "main", 0), { wrapper })

    await act(async () => {})
    expect(result.current.count).toBeNull()
    expect(testApi.invoke).not.toHaveBeenCalled()
  })
})
