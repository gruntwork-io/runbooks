import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import { GitClone } from ".."

// SSH remotes clone with SSH keys, never with the linked sign-in's token, so
// the block says so and offers the HTTPS form of the URL.
let testApi: TestApi

const SESSION: Result<"session:get"> = {
  workingDir: "/work",
  executionCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
}

const GITLAB_NOTE =
  "This URL uses your SSH keys, not your GitLab sign-in. Use the HTTPS URL to clone with the sign-in."

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
    activeWorkTree: null,
    workTrees: [],
  }),
}))

function Seed({ id, values }: { id: string; values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs(id, values)
  }, [id, values, registerOutputs])
  return null
}

const GITLAB_SIGN_IN = { __AUTHENTICATED: "true", GIT_PROVIDER: "gitlab" }

function renderClone(prefilledUrl: string, signIn?: Record<string, string>) {
  return render(
    <ApiProvider api={testApi.api}>
      <TestWrapper>
        {signIn && <Seed id="git-auth" values={signIn} />}
        <GitClone id="clone-repo" gitAuthId="git-auth" prefilledUrl={prefilledUrl} />
      </TestWrapper>
    </ApiProvider>,
  )
}

/** How Electron rejects an invoke whose handler threw. */
function failCloneWith(message: string) {
  testApi.handle("git:clone", () => {
    throw new Error(`Error invoking remote method 'git:clone': Error: ${message}`)
  })
}

beforeEach(() => {
  testApi = makeTestApi({
    "session:get": () => SESSION,
    "github:orgs": () => [],
    "native:set-theme": () => ({ ok: true }),
  })
})

describe("GitClone — SSH URL with a linked sign-in", () => {
  it("explains that an scp-form URL ignores the GitLab sign-in and rewrites it to HTTPS", async () => {
    const user = userEvent.setup()
    renderClone("git@gitlab.com:gruntwork-io/demo/infrastructure-live-azure.git", GITLAB_SIGN_IN)

    expect(await screen.findByText(GITLAB_NOTE)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Use HTTPS URL" }))

    expect(
      screen.getByDisplayValue(
        "https://gitlab.com/gruntwork-io/demo/infrastructure-live-azure.git",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(GITLAB_NOTE)).not.toBeInTheDocument()
  })

  it("uses the self-managed instance's web host and port, not the SSH port", async () => {
    const user = userEvent.setup()
    renderClone("ssh://git@gitlab.corp:2222/platform/team/live.git", {
      ...GITLAB_SIGN_IN,
      GITLAB_HOST: "https://gitlab.corp:8443",
    })

    await user.click(await screen.findByRole("button", { name: "Use HTTPS URL" }))
    expect(
      screen.getByDisplayValue("https://gitlab.corp:8443/platform/team/live.git"),
    ).toBeInTheDocument()
  })

  it("names GitHub for a GitHub sign-in", async () => {
    renderClone("git@github.com:acme/infra.git", {
      __AUTHENTICATED: "true",
      GIT_PROVIDER: "github",
    })

    expect(
      await screen.findByText(
        "This URL uses your SSH keys, not your GitHub sign-in. Use the HTTPS URL to clone with the sign-in.",
      ),
    ).toBeInTheDocument()
  })

  it("says nothing for an HTTPS URL", async () => {
    renderClone("https://gitlab.com/group/project.git", GITLAB_SIGN_IN)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Clone$/i })).toBeInTheDocument(),
    )
    expect(screen.queryByText(GITLAB_NOTE)).not.toBeInTheDocument()
  })

  it("says nothing before the linked block has signed in", async () => {
    renderClone("git@gitlab.com:group/project.git")

    await waitFor(() =>
      expect(screen.getByDisplayValue("git@gitlab.com:group/project.git")).toBeInTheDocument(),
    )
    expect(screen.queryByText(GITLAB_NOTE)).not.toBeInTheDocument()
  })

  it("adds the hint to an SSH authentication failure", async () => {
    failCloneWith(
      "no such identity: /home/me/.ssh/gruntwork_gitlab: No such file or directory\n" +
        "git@gitlab.com: Permission denied (publickey).\n" +
        "fatal: Could not read from remote repository.",
    )
    const user = userEvent.setup()
    renderClone("git@gitlab.com:group/sub/project.git", GITLAB_SIGN_IN)

    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
    await user.click(clone)

    expect(await screen.findByText("Clone failed")).toBeInTheDocument()
    // Once under the URL field and once in the error.
    expect(screen.getAllByText(GITLAB_NOTE)).toHaveLength(2)
  })

  it("adds no hint to a failure that is not about SSH authentication", async () => {
    failCloneWith("fatal: Could not resolve hostname gitlab.com")
    const user = userEvent.setup()
    renderClone("git@gitlab.com:group/project.git", GITLAB_SIGN_IN)

    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
    await user.click(clone)

    expect(await screen.findByText("Clone failed")).toBeInTheDocument()
    expect(screen.getAllByText(GITLAB_NOTE)).toHaveLength(1)
  })
})
