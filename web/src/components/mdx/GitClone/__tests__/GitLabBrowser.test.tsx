import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { useEffect } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import type { GitLabProject } from "../../../../../../electron/shared/channels.ts"
import { GitClone } from ".."

// The IPC boundary is the only thing faked: the real useGitClone fetchers feed
// the real GitLabBrowser, so these tests cover the channel mapping too.
let testApi: TestApi

const SESSION: Result<"session:get"> = {
  workingDir: "/work",
  executionCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
}

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
    activeWorkTree: null,
    workTrees: [],
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

const HOST = "gitlab.corp:8443"

const NAMESPACES: Result<"gitlab:namespaces"> = [
  { id: 7, kind: "user", fullPath: "tanuki" },
  { id: 10, kind: "group", fullPath: "acme" },
  { id: 11, kind: "group", fullPath: "acme/platform" },
]

const project = (path: string, defaultBranch?: string): GitLabProject => ({
  id: path.length,
  name: path.split("/").pop()!,
  pathWithNamespace: path,
  httpUrlToRepo: `https://${HOST}/${path}.git`,
  ...(defaultBranch ? { defaultBranch } : {}),
  visibility: "private",
})

function Seed({ values }: { values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs("git-auth", values)
  }, [values, registerOutputs])
  return null
}

const GITLAB_AUTH = { __AUTHENTICATED: "true", GIT_PROVIDER: "gitlab", GITLAB_HOST: HOST }

function renderLinked(values: Record<string, string> = GITLAB_AUTH, props = {}) {
  return render(
    <ApiProvider api={testApi.api}>
      <TestWrapper>
        <Seed values={values} />
        <GitClone id="clone-repo" gitAuthId="git-auth" prefilledLocalPath="out" {...props} />
      </TestWrapper>
    </ApiProvider>,
  )
}

async function openBrowser(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Browse GitLab projects/i }))
}

// Group, Project and Ref, in that order, once each is shown.
const combobox = (index: number) => screen.getAllByRole("combobox")[index]!

async function pick(user: ReturnType<typeof userEvent.setup>, index: number, option: RegExp) {
  await waitFor(() => expect(combobox(index)).toBeEnabled())
  await user.click(combobox(index))
  await user.click(await screen.findByRole("option", { name: option }))
}

const urlField = () => screen.getByPlaceholderText(`https://${HOST}/group/project.git`)
const refField = () => screen.getByPlaceholderText("Defaults to default branch")

beforeEach(() => {
  testApi = makeTestApi({
    "session:get": () => SESSION,
    "github:orgs": () => [],
    "native:set-theme": () => ({ ok: true }),
    "gitlab:namespaces": () => NAMESPACES,
    "gitlab:projects": () => ({ projects: [], truncated: false }),
    "gitlab:refs": () => [],
  })
})

describe("GitLabBrowser", () => {
  it("fills the clone URL and default branch from a project in a nested group", async () => {
    testApi.handle("gitlab:projects", ({ namespace }) => ({
      projects:
        namespace.id === 10
          ? [project("acme/platform/infra-live", "trunk"), project("acme/tools")]
          : [],
      truncated: false,
    }))
    testApi.handle("gitlab:refs", () => [
      { ref: "feature", type: "branch" },
      { ref: "trunk", type: "branch" },
      { ref: "v1.0.0", type: "tag" },
    ])
    const user = userEvent.setup()
    renderLinked()

    await openBrowser(user)
    await pick(user, 0, /^acme$/)
    // Projects in subgroups are listed by their path inside the group.
    await pick(user, 1, /platform\/infra-live/)

    expect(urlField()).toHaveValue(`https://${HOST}/acme/platform/infra-live.git`)
    await waitFor(() => expect(refField()).toHaveValue("trunk"))
    expect(testApi.callsTo("gitlab:namespaces")).toEqual([{ host: HOST }])
    expect(testApi.callsTo("gitlab:projects")).toEqual([
      { namespace: { id: 10, kind: "group" }, host: HOST },
    ])
    expect(testApi.callsTo("gitlab:refs")).toEqual([
      { project: "acme/platform/infra-live", host: HOST },
    ])

    await user.click(combobox(2))
    expect(await screen.findByRole("option", { name: "v1.0.0" })).toBeInTheDocument()
  })

  it("offers the personal namespace alongside the groups", async () => {
    testApi.handle("gitlab:projects", () => ({
      projects: [project("tanuki/dotfiles", "main")],
      truncated: false,
    }))
    const user = userEvent.setup()
    renderLinked()

    await openBrowser(user)
    await pick(user, 0, /tanuki.*personal/)
    await pick(user, 1, /dotfiles/)

    expect(urlField()).toHaveValue(`https://${HOST}/tanuki/dotfiles.git`)
    expect(testApi.callsTo("gitlab:projects")).toEqual([
      { namespace: { id: 7, kind: "user" }, host: HOST },
    ])
  })

  it("searches on the server in a group with more projects than one listing holds", async () => {
    testApi.handle("gitlab:projects", ({ search }) =>
      search
        ? { projects: [project("acme/legacy/old-app", "main")], truncated: false }
        : { projects: [project("acme/recent")], truncated: true },
    )
    const user = userEvent.setup()
    renderLinked()

    await openBrowser(user)
    await pick(user, 0, /^acme$/)
    await waitFor(() => expect(combobox(1)).toBeEnabled())
    await user.click(combobox(1))
    expect(await screen.findByText(/Type to search all of them/)).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText("Search projects..."), "old")
    await user.click(await screen.findByRole("option", { name: /legacy\/old-app/ }))

    expect(urlField()).toHaveValue(`https://${HOST}/acme/legacy/old-app.git`)
    expect(testApi.callsTo("gitlab:projects")).toContainEqual({
      namespace: { id: 10, kind: "group" },
      search: "old",
      host: HOST,
    })
  })

  it("shows why the groups failed to load", async () => {
    testApi.handle("gitlab:namespaces", () => {
      throw new Error(
        "Error invoking remote method 'gitlab:namespaces': Error: No GitLab token for this host available in session",
      )
    })
    const user = userEvent.setup()
    renderLinked()

    await openBrowser(user)

    expect(
      await screen.findByText("No GitLab token for this host available in session"),
    ).toBeInTheDocument()
  })

  it("starts at the project in the block's URL and keeps its ref", async () => {
    testApi.handle("gitlab:projects", () => ({
      projects: [project("acme/platform/infra-live", "main")],
      truncated: false,
    }))
    testApi.handle("gitlab:refs", () => [
      { ref: "main", type: "branch" },
      { ref: "release", type: "branch" },
    ])
    const user = userEvent.setup()
    renderLinked(GITLAB_AUTH, {
      prefilledUrl: `https://${HOST}/acme/platform/infra-live.git`,
      prefilledRef: "release",
    })

    await openBrowser(user)

    await waitFor(() => expect(combobox(0)).toHaveTextContent("acme/platform"))
    await waitFor(() => expect(combobox(1)).toHaveTextContent("infra-live"))
    expect(testApi.callsTo("gitlab:refs")).toEqual([
      { project: "acme/platform/infra-live", host: HOST },
    ])
    expect(refField()).toHaveValue("release")
  })

  it("is not offered for a block linked to a GitHub sign-in", async () => {
    testApi.handle("github:orgs", () => [{ id: 1, login: "octocat" }])
    renderLinked({ __AUTHENTICATED: "true", GIT_PROVIDER: "github" })

    expect(await screen.findByText("Browse GitHub repositories")).toBeInTheDocument()
    expect(screen.queryByText("Browse GitLab projects")).toBeNull()
  })
})
