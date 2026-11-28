import { describe, it, expect, vi, beforeEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"

// useGitClone has no mount effects, so the auth-gate memo can be exercised by
// rendering the hook with controllable block outputs.
let blockOutputs: Record<string, { values: Record<string, string> }> = {}
const registerOutputs = vi.fn()

vi.mock("@/contexts/useRunbook", () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs }),
}))

import { useGitClone } from "../useGitClone"

// The IPC boundary: the typed fake from makeTestApi, through the real
// ApiProvider. Tests answer or hold its channels, and emit
// git:clone-progress events to the hook's listener.
let testApi: TestApi

const SESSION: Result<"session:get"> = {
  workingDir: "/work",
  executionCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
}

beforeEach(() => {
  blockOutputs = {}
  registerOutputs.mockReset()
  testApi = makeTestApi({
    "git:clone-cancel": () => ({ ok: true }),
    "session:get": () => SESSION,
  })
})

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: testApi.api }, children)

type GitCloneOptions = Parameters<typeof useGitClone>[0]

// A block without envFrom unless the test names auth blocks
const renderGitClone = (
  options: Omit<GitCloneOptions, "envFrom"> & { envFrom?: GitCloneOptions["envFrom"] },
) => renderHook(() => useGitClone({ envFrom: [], ...options }), { wrapper })

/**
 * Hold git:clone, so each call stays pending until the test settles it.
 * `cloneId(n)` is the id the nth clone (0-based) was started with.
 */
function holdClones() {
  const clones = testApi.hold("git:clone")
  const cloneId = (index: number) => {
    const id = clones[index]?.params.cloneId
    if (!id) throw new Error(`git:clone #${index} has no cloneId`)
    return id
  }
  return { clones, cloneId }
}

type Cloned = Extract<Result<"git:clone">, { status: "success" }>

const SUCCESS: Cloned = {
  status: "success",
  absolutePath: "/work/infra",
  relativePath: "infra",
  fileCount: 12,
  ref: "main",
  hasCommits: true,
  outputs: { clone_path: "/work/infra" },
}

describe("useGitClone — auth gate (envFrom)", () => {
  it("is met when envFrom names no block", () => {
    const { result } = renderGitClone({ id: "clone" })
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("is met when the named block emitted GITLAB_TOKEN", () => {
    blockOutputs = { gitauth: { values: { GITLAB_TOKEN: "glpat-x", GITLAB_USER: "tanuki" } } }
    const { result } = renderGitClone({ id: "clone", envFrom: ["gitauth"] })
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("is met via __AUTHENTICATED (env-detected GitLab block)", () => {
    // env/cli detection registers only the __AUTHENTICATED marker to block
    // outputs; the token is the block's export, in the main process.
    blockOutputs = { gitauth: { values: { __AUTHENTICATED: "true" } } }
    const { result } = renderGitClone({ id: "clone", envFrom: ["gitauth"] })
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("is NOT met when the named block has no credentials yet", () => {
    blockOutputs = { gitauth: { values: {} } }
    const { result } = renderGitClone({ id: "clone", envFrom: ["gitauth"] })
    expect(result.current.gitHubAuthMet).toBe(false)
  })

  it("is met when the named block emitted GITHUB_TOKEN", () => {
    blockOutputs = { ghauth: { values: { GITHUB_TOKEN: "ghp_x" } } }
    const { result } = renderGitClone({ id: "clone", envFrom: ["ghauth"] })
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it("is NOT met until every named block has signed in", () => {
    blockOutputs = { ghauth: { values: { __AUTHENTICATED: "true" } }, gitauth: { values: {} } }
    const { result } = renderGitClone({ id: "clone", envFrom: ["ghauth", "gitauth"] })
    expect(result.current.gitHubAuthMet).toBe(false)
  })
})

describe("useGitClone — cancel", () => {
  it("stops git in main and ignores the cancelled clone's late result", async () => {
    const { clones, cloneId } = holdClones()
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    expect(result.current.cloneStatus).toBe("running")

    await act(async () => result.current.cancel())
    expect(testApi.invoke).toHaveBeenCalledWith("git:clone-cancel", { cloneId: cloneId(0) })
    expect(result.current.cloneStatus).toBe("ready")

    // The clone finishes anyway (it got past git before the cancel landed).
    await act(async () => {
      clones[0]!.resolve(SUCCESS)
    })

    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.cloneResult).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it("stays busy until main has finished cancelling", async () => {
    // main replies to git:clone-cancel once git has exited and the checkout
    // it made is removed. Until then Clone and Delete & Clone must stay off.
    const { cloneId } = holdClones()
    const cancels = testApi.hold("git:clone-cancel")
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => result.current.cancel())
    expect(testApi.invoke).toHaveBeenCalledWith("git:clone-cancel", { cloneId: cloneId(0) })
    expect(result.current.cloneStatus).toBe("running")
    expect(result.current.cancelling).toBe(true)

    await act(async () => {
      cancels[0]!.resolve({ ok: true })
    })
    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.cancelling).toBe(false)
    expect(result.current.logs.map((l) => l.line)).toContain("Clone cancelled by user")
  })

  it("comes back from cancelling when the cancel call itself fails", async () => {
    holdClones()
    testApi.handle("git:clone-cancel", () => {
      throw new Error("no handler")
    })
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => result.current.cancel())

    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.cancelling).toBe(false)
  })

  it("does not turn a cancelled clone into a failure when its call rejects", async () => {
    const { clones } = holdClones()
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    act(() => result.current.cancel())
    await act(async () => {
      clones[0]!.reject(new Error("interrupted"))
    })

    expect(result.current.cloneStatus).toBe("ready")
    expect(result.current.errorMessage).toBeNull()
  })

  it("keeps a retry intact while the cancelled clone's events and result arrive", async () => {
    const { clones, cloneId } = holdClones()
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    act(() => result.current.cancel())
    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "", true)
    })
    const first = cloneId(0)
    const retry = cloneId(1)
    expect(retry).not.toBe(first)

    // Progress from the cancelled git is dropped; the retry's own is kept.
    act(() => {
      testApi.emit("git:clone-progress", {
        line: "from the cancelled clone",
        timestamp: "t",
        cloneId: first,
      })
      testApi.emit("git:clone-progress", { line: "from the retry", timestamp: "t", cloneId: retry })
    })
    expect(result.current.logs.map((l) => l.line)).toEqual(["from the retry"])

    // The cancelled clone then ends, as main ends one: { status: "cancelled" }.
    // That is not the retry's failure.
    await act(async () => {
      clones[0]!.resolve({ status: "cancelled" })
    })
    expect(result.current.cloneStatus).toBe("running")
    expect(result.current.errorMessage).toBeNull()

    // Cancel still reaches the retry: the stale run didn't drop its handles.
    act(() => result.current.cancel())
    expect(testApi.invoke).toHaveBeenLastCalledWith("git:clone-cancel", { cloneId: retry })
    act(() => {
      testApi.emit("git:clone-progress", { line: "after cancel", timestamp: "t", cloneId: retry })
    })
    expect(result.current.logs.map((l) => l.line)).not.toContain("after cancel")
  })
})

describe("useGitClone — token check", () => {
  it("moves a fresh block from pending to ready", async () => {
    testApi.handle("github:orgs", () => [])
    const { result } = renderGitClone({ id: "clone" })
    expect(result.current.cloneStatus).toBe("pending")

    await act(async () => {
      await result.current.checkGitHubToken()
    })
    expect(result.current.cloneStatus).toBe("ready")
  })

  it("leaves a clone that started while it ran in the running state", async () => {
    const orgs = testApi.hold("github:orgs")
    const clones = testApi.hold("git:clone")
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.checkGitHubToken()
    })
    act(() => {
      void result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => {
      orgs[0]!.resolve([{ id: 1, login: "acme" }])
    })

    expect(result.current.cloneStatus).toBe("running")
    expect(result.current.tokenChecked).toBe(true)

    await act(async () => {
      clones[0]!.resolve(SUCCESS)
    })
    expect(result.current.cloneStatus).toBe("success")
  })

  it("leaves a clone that already finished in the success state", async () => {
    const orgs = testApi.hold("github:orgs")
    testApi.handle("git:clone", () => SUCCESS)
    const { result } = renderGitClone({ id: "clone" })

    act(() => {
      void result.current.checkGitHubToken()
    })
    await act(async () => {
      await result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    await act(async () => {
      orgs[0]!.resolve([])
    })

    expect(result.current.cloneStatus).toBe("success")
  })
})

describe("useGitClone — reset", () => {
  it("withdraws the outputs a previous clone published", async () => {
    testApi.handle("git:clone", () => SUCCESS)
    const { result } = renderGitClone({ id: "clone" })

    await act(async () => {
      await result.current.clone("https://github.com/acme/infra.git", "", "", "")
    })
    expect(registerOutputs).toHaveBeenLastCalledWith("clone", SUCCESS.outputs)

    act(() => result.current.reset())
    expect(registerOutputs).toHaveBeenLastCalledWith("clone", {})
    expect(result.current.cloneStatus).toBe("ready")
  })

  describe("with a default-branch seed still in flight", () => {
    const emptyRepo = (name: string): Cloned => ({
      status: "success",
      absolutePath: `/work/${name}`,
      relativePath: name,
      fileCount: 0,
      ref: "",
      hasCommits: false,
      outputs: { clone_path: `/work/${name}` },
    })

    /**
     * Clone empty repo one and start seeding it, then "Clone again" and clone
     * empty repo two. Returns the seed call, still unanswered.
     */
    async function seedThenCloneAnother() {
      const clones = [emptyRepo("one"), emptyRepo("two")]
      testApi.handle("git:clone", () => {
        const next = clones.shift()
        if (!next) throw new Error("no more clones scripted")
        return next
      })
      const seeds = testApi.hold("git:init-default-branch")
      const hook = renderGitClone({ id: "clone" })

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
      return { ...hook, seed: seeds[0]! }
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
    testApi.handle("github:orgs", () => [])
    testApi.handle("github:repos", () => [])
    testApi.handle("github:refs", () => [])
    const { result } = renderGitClone({ id: "clone" })
    expect(result.current.githubHost).toBe("github.com")
    await act(async () => {
      await result.current.fetchOrgs()
      await result.current.fetchRepos("acme")
      await result.current.fetchRefs("acme", "infra")
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:orgs", { host: "github.com", envFrom: [] })
    expect(testApi.invoke).toHaveBeenCalledWith("github:repos", {
      org: "acme",
      host: "github.com",
      envFrom: [],
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:refs", {
      owner: "acme",
      repo: "infra",
      host: "github.com",
      envFrom: [],
    })
  })

  it("follows the auth block's GITHUB_HOST output (GitHub Enterprise), and names it in envFrom", async () => {
    blockOutputs = {
      gitauth: {
        values: { __AUTHENTICATED: "true", GIT_PROVIDER: "github", GITHUB_HOST: "GHES.corp" },
      },
    }
    testApi.handle("github:orgs", () => [])
    testApi.handle("github:repos", () => [])
    const { result } = renderGitClone({ id: "clone", envFrom: ["gitauth"] })
    expect(result.current.githubHost).toBe("ghes.corp")
    await act(async () => {
      await result.current.checkGitHubToken()
      await result.current.fetchRepos("acme")
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:orgs", {
      host: "ghes.corp",
      envFrom: ["gitauth"],
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:repos", {
      org: "acme",
      host: "ghes.corp",
      envFrom: ["gitauth"],
    })
  })

  it("follows the last named block that has a GITHUB_HOST output", () => {
    blockOutputs = {
      dotcom: { values: { __AUTHENTICATED: "true", GITHUB_HOST: "github.com" } },
      ghes: { values: { __AUTHENTICATED: "true", GITHUB_HOST: "ghes.corp" } },
    }
    const { result } = renderGitClone({ id: "clone", envFrom: ["dotcom", "ghes"] })
    expect(result.current.githubHost).toBe("ghes.corp")
  })

  it("ignores an unparseable GITHUB_HOST output (falls back to github.com)", () => {
    blockOutputs = { ghauth: { values: { __AUTHENTICATED: "true", GITHUB_HOST: "ftp://nope" } } }
    const { result } = renderGitClone({ id: "clone", envFrom: ["ghauth"] })
    expect(result.current.githubHost).toBe("github.com")
  })
})
