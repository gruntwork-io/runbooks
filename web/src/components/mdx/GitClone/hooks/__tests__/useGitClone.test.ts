import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"

// useGitClone has no mount effects, so the auth-gate memo can be exercised by
// rendering the hook with controllable block outputs.
let blockOutputs: Record<string, { values: Record<string, string> }> = {}
const registerOutputs = vi.fn()

// The IPC boundary: invoke is scripted per test, and `on` keeps real
// listeners so tests can deliver git:clone-progress events to them.
const invoke = vi.fn()
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const on = vi.fn((channel: string, callback: (payload: unknown) => void) => {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel)!.add(callback)
  return () => {
    listeners.get(channel)?.delete(callback)
  }
})
const emit = (channel: string, payload: unknown) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload)
}
const api = { invoke, on }

vi.mock("@/contexts/useRunbook", () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs }),
}))
vi.mock("@/contexts/ApiContext", () => ({
  useApi: () => api,
}))

import { useGitClone } from "../useGitClone"

beforeEach(() => {
  blockOutputs = {}
  registerOutputs.mockReset()
  invoke.mockReset()
  invoke.mockImplementation(async () => ({}))
  on.mockClear()
  listeners.clear()
})

/** A promise the test settles by hand, standing in for a slow IPC call. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type CloneReply = {
  status: string
  error?: string
  outputs?: Record<string, string>
  hasCommits?: boolean
  absolutePath?: string
}

/**
 * Script git:clone so each call returns the next pending promise, and record
 * the cloneId each call was made with.
 */
function scriptClones(count: number) {
  const pending = Array.from({ length: count }, () => deferred<CloneReply>())
  const cloneIds: string[] = []
  invoke.mockImplementation(async (channel: string, params?: { cloneId?: string }) => {
    if (channel === "git:clone") {
      cloneIds.push(params!.cloneId!)
      return pending[cloneIds.length - 1].promise
    }
    return {}
  })
  return { pending, cloneIds }
}

const SUCCESS: CloneReply = {
  status: "success",
  absolutePath: "/work/infra",
  hasCommits: true,
  outputs: { clone_path: "/work/infra" },
}

describe("useGitClone — auth gate (gitAuthId / githubAuthId)", () => {
  it("is met when there is no auth dependency", () => {
    const { result } = renderHook(() => useGitClone({ id: "clone" }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("gitAuthId is met when the referenced block emitted GITLAB_TOKEN", () => {
    blockOutputs = { gitauth: { values: { GITLAB_TOKEN: "glpat-x", GITLAB_USER: "tanuki" } } }
    const { result } = renderHook(() => useGitClone({ id: "clone", gitAuthId: "gitauth" }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("gitAuthId is met via __AUTHENTICATED (env-detected GitLab block)", () => {
    // env/cli detection registers only the __AUTHENTICATED marker to block
    // outputs; the token lives in session env.
    blockOutputs = { gitauth: { values: { __AUTHENTICATED: "true" } } }
    const { result } = renderHook(() => useGitClone({ id: "clone", gitAuthId: "gitauth" }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("gitAuthId is NOT met when the referenced block has no credentials yet", () => {
    blockOutputs = { gitauth: { values: {} } }
    const { result } = renderHook(() => useGitClone({ id: "clone", gitAuthId: "gitauth" }))
    expect(result.current.gitHubAuthMet).toBe(false)
  })

  it("githubAuthId still gates on GITHUB_TOKEN (regression)", () => {
    blockOutputs = { ghauth: { values: { GITHUB_TOKEN: "ghp_x" } } }
    const { result } = renderHook(() => useGitClone({ id: "clone", githubAuthId: "ghauth" }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("githubAuthId is NOT met for an empty referenced block", () => {
    blockOutputs = { ghauth: { values: {} } }
    const { result } = renderHook(() => useGitClone({ id: "clone", githubAuthId: "ghauth" }))
    expect(result.current.gitHubAuthMet).toBe(false)
  })
})

describe("useGitClone — cancel", () => {
  it("stops git in main and ignores the cancelled clone's late result", async () => {
    const { pending, cloneIds } = scriptClones(1)
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    expect(result.current.cloneStatus).toBe("running")

    await act(async () => result.current.cancel())
    expect(invoke).toHaveBeenCalledWith("git:clone-cancel", { cloneId: cloneIds[0] })
    expect(result.current.cloneStatus).toBe("ready")

    // The clone finishes anyway (it got past git before the cancel landed).
    await act(async () => {
      pending[0].resolve(SUCCESS)
    })

    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.cloneResult).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it("stays busy until main has finished cancelling", async () => {
    // main replies to git:clone-cancel once git has exited and the checkout
    // it made is removed. Until then Clone and Delete & Clone must stay off.
    const { cloneIds } = scriptClones(1)
    const cloneReply = invoke.getMockImplementation()!
    const cancelReply = deferred<{ ok: true }>()
    invoke.mockImplementation(async (channel: string, params?: { cloneId?: string }) =>
      channel === "git:clone-cancel" ? cancelReply.promise : cloneReply(channel, params),
    )
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => result.current.cancel())
    expect(invoke).toHaveBeenCalledWith("git:clone-cancel", { cloneId: cloneIds[0] })
    expect(result.current.cloneStatus).toBe("running")
    expect(result.current.cancelling).toBe(true)

    await act(async () => {
      cancelReply.resolve({ ok: true })
    })
    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.cancelling).toBe(false)
    expect(result.current.logs.map((l) => l.line)).toContain("Clone cancelled by user")
  })

  it("comes back from cancelling when the cancel call itself fails", async () => {
    scriptClones(1)
    const cloneReply = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, params?: { cloneId?: string }) => {
      if (channel === "git:clone-cancel") throw new Error("no handler")
      return cloneReply(channel, params)
    })
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => result.current.cancel())

    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.cancelling).toBe(false)
  })

  it("does not turn a cancelled clone into a failure when its call rejects", async () => {
    const { pending } = scriptClones(1)
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    act(() => result.current.cancel())
    await act(async () => {
      pending[0].reject(new Error("interrupted"))
    })

    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.errorMessage).toBeNull()
  })

  it("keeps a retry intact while the cancelled clone's events and result arrive", async () => {
    const { pending, cloneIds } = scriptClones(2)
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    act(() => result.current.cancel())
    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "", true)
    })
    const [first, retry] = cloneIds
    expect(retry).not.toBe(first)

    // Progress from the cancelled git is dropped; the retry's own is kept.
    act(() => {
      emit("git:clone-progress", {
        line: "from the cancelled clone",
        timestamp: "t",
        cloneId: first,
      })
      emit("git:clone-progress", { line: "from the retry", timestamp: "t", cloneId: retry })
    })
    expect(result.current.logs.map((l) => l.line)).toEqual(["from the retry"])

    // The cancelled clone then fails (its directory was deleted by the retry's
    // "Delete & Clone"). That is not the retry's failure.
    await act(async () => {
      pending[0].resolve({ status: "fail", error: "destination vanished" })
    })
    expect(result.current.cloneStatus).toBe("running")
    expect(result.current.errorMessage).toBeNull()

    // Cancel still reaches the retry: the stale run didn't drop its handles.
    act(() => result.current.cancel())
    expect(invoke).toHaveBeenLastCalledWith("git:clone-cancel", { cloneId: retry })
    act(() => {
      emit("git:clone-progress", { line: "after cancel", timestamp: "t", cloneId: retry })
    })
    expect(result.current.logs.map((l) => l.line)).not.toContain("after cancel")
  })
})

describe("useGitClone — token check", () => {
  it("moves a fresh block from pending to ready", async () => {
    invoke.mockImplementation(async (channel: string) => (channel === "github:orgs" ? [] : {}))
    const { result } = renderHook(() => useGitClone({ id: "clone" }))
    expect(result.current.cloneStatus).toBe("pending")

    await act(async () => {
      await result.current.checkGitHubToken()
    })
    expect(result.current.cloneStatus).toBe("ready")
  })

  it("leaves a clone that started while it ran in the running state", async () => {
    const orgs = deferred<unknown[]>()
    const clone = deferred<CloneReply>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "github:orgs") return orgs.promise
      if (channel === "git:clone") return clone.promise
      return {}
    })
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.checkGitHubToken()
    })
    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => {
      orgs.resolve([{ login: "acme" }])
    })

    expect(result.current.cloneStatus).toBe("running")
    expect(result.current.tokenChecked).toBe(true)

    await act(async () => {
      clone.resolve(SUCCESS)
    })
    expect(result.current.cloneStatus).toBe("success")
  })

  it("leaves a clone that already finished in the success state", async () => {
    const orgs = deferred<unknown[]>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "github:orgs") return orgs.promise
      if (channel === "git:clone") return SUCCESS
      return {}
    })
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    act(() => {
      void result.current.checkGitHubToken()
    })
    await act(async () => {
      await result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => {
      orgs.resolve([])
    })

    expect(result.current.cloneStatus).toBe("success")
  })
})

describe("useGitClone — reset", () => {
  it("withdraws the outputs a previous clone published", async () => {
    invoke.mockImplementation(async (channel: string) => (channel === "git:clone" ? SUCCESS : {}))
    const { result } = renderHook(() => useGitClone({ id: "clone" }))

    await act(async () => {
      await result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    expect(registerOutputs).toHaveBeenLastCalledWith("clone", SUCCESS.outputs)

    act(() => result.current.reset())
    expect(registerOutputs).toHaveBeenLastCalledWith("clone", {})
    expect(result.current.cloneStatus).toBe("ready")
  })

  describe("with a default-branch seed still in flight", () => {
    const emptyRepo = (name: string): CloneReply => ({
      status: "success",
      absolutePath: `/work/${name}`,
      hasCommits: false,
      outputs: { clone_path: `/work/${name}` },
    })

    /**
     * Clone empty repo one and start seeding it, then "Clone again" and clone
     * empty repo two. Returns the seed call, still unanswered.
     */
    async function seedThenCloneAnother() {
      const clones = [emptyRepo("one"), emptyRepo("two")]
      const seed = deferred<{ branch: string }>()
      invoke.mockImplementation(async (channel: string) => {
        if (channel === "git:clone") return clones.shift()
        if (channel === "git:init-default-branch") return seed.promise
        return {}
      })
      const hook = renderHook(() => useGitClone({ id: "clone" }))

      await act(async () => {
        await hook.result.current.clone("https://github.com/acme/one.git", "", "", "")
      })
      act(() => {
        void hook.result.current.initDefaultBranch("main")
      })
      act(() => hook.result.current.reset())
      await act(async () => {
        await hook.result.current.clone("https://github.com/acme/two.git", "", "", "")
      })
      registerOutputs.mockClear()
      return { ...hook, seed }
    }

    it("doesn't publish the next repo's held-back outputs when it succeeds", async () => {
      const { result, seed } = await seedThenCloneAnother()

      await act(async () => {
        seed.resolve({ branch: "main" })
      })

      // Repo two has no commits of its own, so it stays held back.
      expect(registerOutputs).not.toHaveBeenCalled()
      expect(result.current.cloneResult).toMatchObject({
        absolutePath: "/work/two",
        hasCommits: false,
      })
      expect(result.current.seedStatus).toBe("idle")
    })

    it("doesn't report its failure against the next repo", async () => {
      const { result, seed } = await seedThenCloneAnother()

      await act(async () => {
        seed.reject(new Error("push rejected"))
      })

      expect(result.current.seedStatus).toBe("idle")
      expect(result.current.seedError).toBeNull()
    })
  })
})

describe("useGitClone — GitHub host of the linked auth block", () => {
  it("defaults to github.com and passes it on every github:* query", async () => {
    invoke.mockImplementation(async (channel: string) => (channel.startsWith("github:") ? [] : {}))
    const { result } = renderHook(() => useGitClone({ id: "clone" }))
    expect(result.current.githubHost).toBe("github.com")
    await act(async () => {
      await result.current.fetchOrgs()
      await result.current.fetchRepos("acme")
      await result.current.fetchRefs("acme", "infra")
    })
    expect(invoke).toHaveBeenCalledWith("github:orgs", { host: "github.com" })
    expect(invoke).toHaveBeenCalledWith("github:repos", { org: "acme", host: "github.com" })
    expect(invoke).toHaveBeenCalledWith("github:refs", {
      owner: "acme",
      repo: "infra",
      host: "github.com",
    })
  })

  it("follows the auth block's GITHUB_HOST output (GitHub Enterprise)", async () => {
    blockOutputs = {
      gitauth: {
        values: { __AUTHENTICATED: "true", GIT_PROVIDER: "github", GITHUB_HOST: "GHES.corp" },
      },
    }
    const { result } = renderHook(() => useGitClone({ id: "clone", gitAuthId: "gitauth" }))
    expect(result.current.githubHost).toBe("ghes.corp")
    await act(async () => {
      await result.current.checkGitHubToken()
      await result.current.fetchRepos("acme")
    })
    expect(invoke).toHaveBeenCalledWith("github:orgs", { host: "ghes.corp" })
    expect(invoke).toHaveBeenCalledWith("github:repos", { org: "acme", host: "ghes.corp" })
  })

  it("ignores an unparseable GITHUB_HOST output (falls back to github.com)", () => {
    blockOutputs = { ghauth: { values: { __AUTHENTICATED: "true", GITHUB_HOST: "ftp://nope" } } }
    const { result } = renderHook(() => useGitClone({ id: "clone", githubAuthId: "ghauth" }))
    expect(result.current.githubHost).toBe("github.com")
  })
})
