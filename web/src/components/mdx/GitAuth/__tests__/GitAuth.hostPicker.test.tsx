import { describe, it, expect, vi, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type Result, type TestApi } from "@/test/test-api"

// The GitLab host picker against the REAL useGitAuth hook: what the select
// shows and what "Other instance…" does are only visible with the hook, the
// picker and the PAT form wired together.
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from "../GitAuth"

const HOSTS: Result<"gitlab:enumerate-hosts"> = {
  hosts: [
    { host: "gitlab.com", sources: ["glab"], hasCredential: true },
    { host: "git.corp.example", sources: ["recent"], hasCredential: false },
  ],
  defaultHost: "gitlab.com",
}

// Both CLIs installed, for the manual UI's hint.
const CLI_STATUS = {
  gh: { installed: true, version: "2.60.0", meetsFloor: true },
  glab: { installed: true, version: "1.80.0", meetsFloor: true },
}

let currentApi: TestApi

/** A machine with no GitLab credential to detect, plus `handlers`. */
function installApi(handlers: Handlers) {
  currentApi = makeTestApi({
    "gitlab:env-credentials": () => ({ found: false }),
    "gitlab:cli-credentials": () => ({ found: false }),
    "gitlab:host-picked": () => ({ ok: true }),
    "vcs:invalidate-cache": () => ({ ok: true }),
    "vcs:cli-status": () => CLI_STATUS,
    ...handlers,
  })
  return currentApi
}

function renderWithApi(ui: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi.api}>{ui}</ApiProvider>
    </TestWrapper>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

const instanceField = () => screen.getByPlaceholderText("https://gitlab.com")

describe("GitAuth — GitLab host picker (real hook)", () => {
  it("'Other instance…' leaves the success card and focuses the instance-URL field", async () => {
    installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "tanuki" },
        host: "gitlab.com",
        envVar: "GITLAB_TOKEN",
      }),
    })

    renderWithApi(<GitAuth id="git" provider="gitlab" />)
    await screen.findByText(/Authenticated to GitLab \(gitlab\.com\)/)

    const select = screen.getByRole("combobox")
    fireEvent.change(select, { target: { value: "__other__" } })

    await waitFor(() => expect(instanceField()).toHaveFocus())
    expect(screen.queryByText(/Authenticated to GitLab/)).toBeNull()
    // The sentinel is not a host: the select snaps back.
    expect(select).toHaveValue("gitlab.com")
  })

  it("shows an entered instance in the picker, and picking a listed host replaces it", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
    })

    renderWithApi(<GitAuth id="git" provider="gitlab" />)
    await screen.findByPlaceholderText(/GitLab access token/i)
    const select = screen.getByRole("combobox")

    fireEvent.change(select, { target: { value: "__other__" } })
    await waitFor(() => expect(instanceField()).toHaveFocus())
    fireEvent.change(instanceField(), { target: { value: "https://gitlab.new.example" } })

    // Not the first listed host: that would hide what detection targets, and
    // picking it would fire no change.
    expect(select).toHaveValue("gitlab.new.example")

    const callsBefore = testApi.calls.length
    fireEvent.change(select, { target: { value: "gitlab.com" } })

    await waitFor(() => {
      expect(testApi.calls.slice(callsBefore)).toContainEqual({
        channel: "gitlab:cli-credentials",
        params: { host: "gitlab.com" },
      })
    })
    await screen.findByPlaceholderText("https://gitlab.com")
    expect(instanceField()).toHaveValue("")
    expect(select).toHaveValue("gitlab.com")
    // The re-detection remounted the form; the earlier pick doesn't re-take focus.
    expect(instanceField()).not.toHaveFocus()
  })
})
