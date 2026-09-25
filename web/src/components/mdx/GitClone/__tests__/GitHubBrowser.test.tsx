import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import GitClone from ".."

// The IPC boundary is the only thing mocked — the real useGitClone fetchers
// feed the real GitHubBrowser, so these tests cover the channel mapping too.
// The api object is stable, as the real context value is, so the fetchers
// keep their identity across renders.
const invoke = vi.fn()
const api = { invoke, on: vi.fn(() => () => {}) }

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => api }
})

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
    activeWorkTree: null,
    workTrees: [],
    setActiveWorkTree: vi.fn(),
    resetWorkTrees: vi.fn(),
    invalidateGitFileTree: vi.fn(),
    treeVersion: 0,
    activeWorkTreeId: null,
  }),
}))

// cmdk and Radix measure and scroll elements, which jsdom doesn't implement.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView ??= function () {}
  Element.prototype.scrollTo ??= function () {}
})

/** A promise the test settles by hand, standing in for a slow IPC call. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const ORGS = [{ id: 1, login: "acme" }, { id: 2, login: "globex" }]

const repo = (id: number, name: string, defaultBranch = "main") =>
  ({ id, ownerId: 1, name, fullName: `acme/${name}`, private: false, defaultBranch })

/** Channel-shaped refs: the backend sends `ref`, not `name`. */
const branches = (...names: string[]) => names.map((ref) => ({ ref, type: "branch" as const }))

type Handlers = {
  repos?: (org: string) => Promise<unknown>
  refs?: (owner: string, repo: string) => Promise<unknown>
  orgs?: () => Promise<unknown>
}

/** Answer the block's mount calls, and route the GitHub browser's to the test. */
function mockIpc({ repos, refs, orgs }: Handlers = {}) {
  let orgCalls = 0
  invoke.mockImplementation(async (channel: string, params?: Record<string, string>) => {
    if (channel === "session:get") return { workingDir: "/work" }
    // The first call is the block's token check, which shows the browser.
    if (channel === "github:orgs") return orgCalls++ === 0 || !orgs ? ORGS : orgs()
    if (channel === "github:repos") return repos ? repos(params!.org) : []
    if (channel === "github:refs") return refs ? refs(params!.owner, params!.repo) : []
    return {}
  })
}

function renderGitClone(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitClone id="test-clone" {...props} />
    </TestWrapper>,
  )
}

async function openBrowser(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Browse GitHub repositories/i }))
}

// Organization, Repository and Ref, in that order, once each is shown.
const combobox = (index: number) => screen.getAllByRole("combobox")[index]

async function pick(user: ReturnType<typeof userEvent.setup>, index: number, option: string) {
  await waitFor(() => expect(combobox(index)).toBeEnabled())
  await user.click(combobox(index))
  await user.click(await screen.findByRole("option", { name: option }))
}

const refField = () => screen.getByPlaceholderText("Defaults to default branch")

beforeEach(() => {
  invoke.mockReset()
})

describe("GitHubBrowser — errors", () => {
  it("shows why a repository list failed instead of an empty list", async () => {
    mockIpc({
      repos: async () => {
        throw new Error("Error invoking remote method 'github:repos': Error: GitHub API error 403: SAML enforcement")
      },
    })
    const user = userEvent.setup()
    renderGitClone({ prefilledUrl: "https://github.com/acme/infra" })

    await openBrowser(user)

    expect(await screen.findByText("GitHub API error 403: SAML enforcement")).toBeInTheDocument()
  })

  it("retries a failed organization load when the browser is reopened", async () => {
    let fail = true
    mockIpc({
      orgs: async () => {
        if (fail) throw new Error("GitHub API error 502: Bad Gateway")
        return ORGS
      },
    })
    const user = userEvent.setup()
    renderGitClone()

    await openBrowser(user)
    expect(await screen.findByText("GitHub API error 502: Bad Gateway")).toBeInTheDocument()

    fail = false
    await openBrowser(user) // collapse
    await openBrowser(user) // expand again
    await user.click(combobox(0))
    expect(await screen.findByRole("option", { name: /globex/ })).toBeInTheDocument()
  })
})

describe("GitHubBrowser — refs", () => {
  it("lists ref names and selects the picked repo's default branch", async () => {
    mockIpc({
      repos: async () => [repo(1, "infra", "trunk")],
      refs: async () => [...branches("feature", "trunk"), { ref: "v1.0.0", type: "tag" }],
    })
    const user = userEvent.setup()
    renderGitClone({ prefilledLocalPath: "out" })

    await openBrowser(user)
    await pick(user, 0, "acme")
    await pick(user, 1, "infra")

    await waitFor(() => expect(refField()).toHaveValue("trunk"))
    await user.click(combobox(2))
    expect(await screen.findByRole("option", { name: "v1.0.0" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "feature" })).toBeInTheDocument()
  })

  it("clears the previous repo's ref when the picked repo has no default branch yet", async () => {
    mockIpc({
      repos: async () => [repo(1, "infra"), repo(2, "fresh")],
      // A repo with no commits reports a default branch but has no branches.
      refs: async (_owner, name) => (name === "infra" ? branches("main") : []),
    })
    const user = userEvent.setup()
    renderGitClone({ prefilledLocalPath: "out" })

    await openBrowser(user)
    await pick(user, 0, "acme")
    await pick(user, 1, "infra")
    await waitFor(() => expect(refField()).toHaveValue("main"))

    await pick(user, 1, "fresh")
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("github:refs", { owner: "acme", repo: "fresh" }))
    await act(async () => {})

    expect(refField()).toHaveValue("")
  })

  it("keeps the chosen ref when the selected repo is picked again", async () => {
    mockIpc({
      repos: async () => [repo(1, "infra")],
      refs: async () => [...branches("main"), { ref: "v1.0.0", type: "tag" }],
    })
    const user = userEvent.setup()
    renderGitClone({ prefilledLocalPath: "out" })

    await openBrowser(user)
    await pick(user, 0, "acme")
    await pick(user, 1, "infra")
    await waitFor(() => expect(refField()).toHaveValue("main"))
    await pick(user, 2, "v1.0.0")
    await pick(user, 1, "infra")

    expect(refField()).toHaveValue("v1.0.0")
  })

  it("keeps the block's prefilled ref for the repo seeded from its URL", async () => {
    const refs = deferred<unknown>()
    mockIpc({
      repos: async () => [repo(1, "infra")],
      refs: () => refs.promise,
    })
    renderGitClone({ prefilledUrl: "https://github.com/acme/infra", prefilledRef: "v1.2.0" })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("github:refs", { owner: "acme", repo: "infra" }))
    await act(async () => { refs.resolve(branches("main", "v1.2.0-hotfix")) })

    expect(refField()).toHaveValue("v1.2.0")
  })

  it("drops a slower earlier repo's refs when another repo was picked", async () => {
    const pending: Record<string, ReturnType<typeof deferred<unknown>>> = {
      alpha: deferred(),
      beta: deferred(),
    }
    mockIpc({
      repos: async () => [repo(1, "alpha", "main"), repo(2, "beta", "master")],
      refs: (_owner, name) => pending[name].promise,
    })
    const user = userEvent.setup()
    renderGitClone({ prefilledLocalPath: "out" })

    await openBrowser(user)
    await pick(user, 0, "acme")
    await pick(user, 1, "alpha")
    await pick(user, 1, "beta")

    await act(async () => { pending.beta.resolve(branches("master", "beta-work")) })
    await act(async () => { pending.alpha.resolve(branches("main", "alpha-work")) })

    expect(refField()).toHaveValue("master")
    await user.click(combobox(2))
    expect(await screen.findByRole("option", { name: "beta-work" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "alpha-work" })).not.toBeInTheDocument()
  })

  it("does not let a switched-away org's refs set the ref", async () => {
    const alphaRefs = deferred<unknown>()
    mockIpc({
      repos: async (org) => (org === "acme" ? [repo(1, "alpha")] : [repo(2, "gamma")]),
      refs: () => alphaRefs.promise,
    })
    const user = userEvent.setup()
    renderGitClone({ prefilledLocalPath: "out" })

    await openBrowser(user)
    await pick(user, 0, "acme")
    await pick(user, 1, "alpha")
    await pick(user, 0, "globex")

    await act(async () => { alphaRefs.resolve(branches("main")) })

    expect(refField()).toHaveValue("")
  })
})

describe("GitHubBrowser — repos", () => {
  it("drops a switched-away org's slower repo list", async () => {
    const pending: Record<string, ReturnType<typeof deferred<unknown>>> = {
      acme: deferred(),
      globex: deferred(),
    }
    mockIpc({ repos: (org) => pending[org].promise })
    const user = userEvent.setup()
    renderGitClone({ prefilledUrl: "https://github.com/acme/infra" })

    await openBrowser(user)
    await pick(user, 0, "globex")

    await act(async () => { pending.globex.resolve([repo(2, "gamma")]) })
    await act(async () => { pending.acme.resolve([repo(1, "alpha")]) })

    await user.click(combobox(1))
    expect(await screen.findByRole("option", { name: "gamma" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "alpha" })).not.toBeInTheDocument()
  })
})
