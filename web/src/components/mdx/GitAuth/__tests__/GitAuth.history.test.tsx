import { describe, it, expect, vi, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { revealOutputs } from "@/lib/outputValues"
import type { SavedGitAuth } from "@/lib/sessionHistory"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// GitAuth blocks under the real session history provider and runbook context.
// The mock boundary is the preload API: the provider channels answer as main
// would, and session:record-event is where a sign-in leaves the renderer.
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from "../GitAuth"
import { GitHubAuth } from "../../GitHubAuth/GitHubAuth"
import { GitLabAuth } from "../../GitLabAuth/GitLabAuth"

type Answer = (channel: string, args: Record<string, unknown>) => unknown

let invoke: ReturnType<typeof vi.fn>

/** A preload API whose channels answer with `answer`, or with nothing. */
function makeApi(answer: Answer): RunbooksAPI {
  invoke = vi.fn(async (channel: string, args?: Record<string, unknown>) => {
    if (channel === "session:record-event") return { ok: true }
    return (await answer(channel, args ?? {})) ?? {}
  })
  return { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI
}

/** Reads the outputs the block published, with sensitive values revealed. */
function OutputsProbe({ id }: { id: string }) {
  const { blockOutputs } = useRunbookContext()
  const values = blockOutputs[id]?.values
  return (
    <div data-testid="published-outputs">
      {JSON.stringify(values ? revealOutputs(values) : null)}
    </div>
  )
}

const publishedOutputs = () =>
  JSON.parse(screen.getByTestId("published-outputs").textContent || "null") as Record<
    string,
    string
  > | null

/** Render `block` in a session whose history says it was left as `saved`. */
function renderInSession(answer: Answer, block: ReactNode, saved?: SavedGitAuth) {
  const api = makeApi(answer)
  const blockStates: SavedBlockState[] =
    saved === undefined ? [] : [{ blockId: "git", kind: "auth", payload: saved }]
  return render(
    <TestWrapper>
      <ApiProvider api={api}>
        <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
          {block}
          <OutputsProbe id="git" />
        </IpcSessionHistoryProvider>
      </ApiProvider>
    </TestWrapper>,
  )
}

/** The payload of each auth event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === "session:record-event")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "git", kind: "auth" })
      return (event as { payload: unknown }).payload
    })

const callsTo = (channel: string) =>
  invoke.mock.calls.filter(([c]) => c === channel).map(([, args]) => args)

/** One host for the provider's picker, as host enumeration reports it. */
const onlyHost = (host: string) => ({
  hosts: [{ host, sources: ["config"], hasCredential: true }],
  defaultHost: host,
})

/** A GitHub sign-in the history has, on an Enterprise host only it knows. */
const SAVED_GITHUB: SavedGitAuth = {
  status: "signed-in",
  block: "git",
  provider: "github",
  host: "github.example.com",
  instanceUrl: "",
  user: { login: "octo" },
  source: "env",
  scopes: ["read:org"],
  tokenType: "classic_pat",
  meta: { source: "env", envVar: "GH_ENTERPRISE_TOKEN" },
  outputs: {
    GITHUB_USER: { value: "octo", sensitive: false },
    GITHUB_HOST: { value: "github.example.com", sensitive: false },
    GIT_PROVIDER: { value: "github", sensitive: false },
    __AUTHENTICATED: { value: "true", sensitive: false },
  },
}

/** Answers for a saved GitHub sign-in whose check is `check`. */
const githubAnswers =
  (check: () => unknown): Answer =>
  (channel) => {
    if (channel === "github:enumerate-hosts") return onlyHost("github.com")
    if (channel === "github:validate") return check()
    return undefined
  }

/** A promise the test settles, for a check still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("GitAuth in a session: recording sign-ins", () => {
  it("records a PAT sign-in with its token as a sensitive output", async () => {
    renderInSession(
      (channel) => {
        if (channel === "gitlab:enumerate-hosts") return onlyHost("gitlab.com")
        if (channel === "gitlab:validate") {
          return { valid: true, user: { login: "tanuki" }, scopes: ["api"], tokenType: "pat" }
        }
        return undefined
      },
      <GitAuth id="git" provider="gitlab" detectCredentials={false} />,
    )

    fireEvent.change(await screen.findByPlaceholderText(/GitLab access token/i), {
      target: { value: "glpat-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))

    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toEqual({
      status: "signed-in",
      block: "git",
      provider: "gitlab",
      host: "gitlab.com",
      instanceUrl: "",
      user: { login: "tanuki" },
      source: null,
      scopes: ["api"],
      tokenType: "pat",
      meta: null,
      outputs: {
        GITLAB_TOKEN: { value: "glpat-secret", sensitive: true },
        GITLAB_USER: { value: "tanuki", sensitive: false },
        GITLAB_HOST: { value: "gitlab.com", sensitive: false },
        GIT_PROVIDER: { value: "gitlab", sensitive: false },
        __AUTHENTICATED: { value: "true", sensitive: false },
      },
    })
  })

  it("records a sign-in that detection found, with its source and without a token", async () => {
    renderInSession(
      (channel) => {
        if (channel === "github:enumerate-hosts") return onlyHost("github.com")
        if (channel === "github:env-credentials") {
          return {
            found: true,
            valid: true,
            user: { login: "octo" },
            scopes: ["repo"],
            tokenType: "classic_pat",
            envVar: "GITHUB_TOKEN",
          }
        }
        return undefined
      },
      <GitAuth id="git" />,
    )

    await screen.findByText(/Authenticated to GitHub/)
    await waitFor(() => expect(recorded()).toHaveLength(1))
    const [saved] = recorded() as SavedGitAuth[]
    expect(saved).toMatchObject({
      status: "signed-in",
      provider: "github",
      host: "github.com",
      user: { login: "octo" },
      source: "env",
      scopes: ["repo"],
      tokenType: "classic_pat",
      meta: { source: "env", envVar: "GITHUB_TOKEN" },
    })
    expect(saved?.status === "signed-in" && Object.keys(saved.outputs).sort()).toEqual([
      "GITHUB_HOST",
      "GITHUB_USER",
      "GIT_PROVIDER",
      "__AUTHENTICATED",
    ])
  })

  it("records a GitHub sign-in in the browser", async () => {
    renderInSession(
      (channel) => {
        if (channel === "github:enumerate-hosts") return onlyHost("github.com")
        if (channel === "github:oauth-start") {
          return {
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
            deviceCode: "device",
            interval: 5,
            expiresIn: 900,
          }
        }
        if (channel === "github:oauth-poll") {
          return {
            status: "complete",
            user: { login: "octo" },
            scopes: ["repo"],
            tokenType: "oauth",
          }
        }
        return undefined
      },
      <GitAuth id="git" detectCredentials={false} />,
    )

    // The tab has the same name as the button that starts the sign-in.
    const [, signIn] = await screen.findAllByRole("button", { name: /Sign in with GitHub/ })
    fireEvent.click(signIn!)

    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toMatchObject({
      status: "signed-in",
      provider: "github",
      user: { login: "octo" },
      tokenType: "oauth",
      scopes: ["repo"],
    })
  })

  it("records one sign-out when the user signs in again or switches providers", async () => {
    renderInSession(
      (channel) => {
        if (channel === "github:enumerate-hosts") return onlyHost("github.com")
        if (channel === "gitlab:enumerate-hosts") return onlyHost("gitlab.com")
        if (channel === "github:validate") {
          return { valid: true, user: { login: "octo" }, scopes: ["repo"] }
        }
        return undefined
      },
      <GitAuth id="git" detectCredentials={false} defaultTab="pat" />,
    )
    fireEvent.change(await screen.findByPlaceholderText(/github_pat_/), {
      target: { value: "ghp_secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))
    await waitFor(() => expect(recorded()).toHaveLength(1))

    fireEvent.click(screen.getByRole("button", { name: /Re-authenticate/ }))
    await waitFor(() => expect(recorded()).toHaveLength(2))
    expect(recorded()[1]).toEqual({ status: "signed-out" })

    fireEvent.click(screen.getByRole("tab", { name: /GitLab/ }))
    await screen.findByPlaceholderText(/GitLab access token/i)
    expect(recorded()).toHaveLength(2)
  })
})

describe("GitAuth in a session: resuming a sign-in", () => {
  it("starts signed in, on the saved host, with its outputs published and no detection", async () => {
    const check = deferred<unknown>()
    renderInSession(
      githubAnswers(() => check.promise),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    expect(screen.getByText(/Authenticated to GitHub \(github\.example\.com\)/)).toBeInTheDocument()
    expect(screen.getByText("Detected from GH_ENTERPRISE_TOKEN")).toBeInTheDocument()
    expect(screen.getByText(/Missing "repo" scope/)).toBeInTheDocument()
    await waitFor(() =>
      expect(publishedOutputs()).toEqual({
        GITHUB_USER: "octo",
        GITHUB_HOST: "github.example.com",
        GIT_PROVIDER: "github",
        __AUTHENTICATED: "true",
      }),
    )
    // The saved host stays pickable although enumeration does not list it.
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("github.example.com"))
    expect(screen.getByRole("option", { name: "github.example.com" })).toBeInTheDocument()

    expect(callsTo("github:env-credentials")).toEqual([])
    expect(callsTo("github:cli-credentials")).toEqual([])
    expect(recorded()).toEqual([])
  })

  it("checks the session's credential for the saved host", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: true, user: { login: "octo" } })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    await waitFor(() => expect(callsTo("github:validate")).toHaveLength(1))
    expect(callsTo("github:validate")[0]).toEqual({
      useSessionToken: true,
      host: "github.example.com",
    })
  })

  it("keeps the sign-in when the session's credential is still the saved user's", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: true, user: { login: "octo" } })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    await waitFor(() => expect(callsTo("github:validate")).toHaveLength(1))
    await act(async () => {})

    expect(screen.getByText(/Authenticated to GitHub/)).toBeInTheDocument()
    expect(publishedOutputs()).toMatchObject({ __AUTHENTICATED: "true" })
    expect(recorded()).toEqual([])
  })

  it("goes back to sign-in when the session's credential now belongs to someone else", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: true, user: { login: "mallory" } })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    expect(
      await screen.findByText(
        "The session's GitHub credential now belongs to mallory, not octo. Sign in again.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Authenticated to GitHub/)).not.toBeInTheDocument()
    expect(publishedOutputs()).toEqual({ GIT_PROVIDER: "github" })
    await waitFor(() => expect(recorded()).toEqual([{ status: "signed-out" }]))
  })

  it("goes back to sign-in when the saved credential no longer works", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: false, error: "Bad credentials" })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    expect(
      await screen.findByText(
        "The sign-in saved with this session no longer works (Bad credentials). Sign in again.",
      ),
    ).toBeInTheDocument()
    expect(publishedOutputs()).toEqual({ GIT_PROVIDER: "github" })
    await waitFor(() => expect(recorded()).toEqual([{ status: "signed-out" }]))
  })

  it("keeps the sign-in when the host cannot be reached", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: false, errorKind: "network", error: "ENOTFOUND" })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    await waitFor(() => expect(callsTo("github:validate")).toHaveLength(1))
    await act(async () => {})

    expect(screen.getByText(/Authenticated to GitHub/)).toBeInTheDocument()
    expect(publishedOutputs()).toMatchObject({ __AUTHENTICATED: "true" })
    expect(recorded()).toEqual([])
  })

  it("ignores a check that comes back after the user signed in again", async () => {
    const check = deferred<unknown>()
    renderInSession(
      githubAnswers(() => check.promise),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )
    await waitFor(() => expect(callsTo("github:validate")).toHaveLength(1))

    fireEvent.click(screen.getByRole("button", { name: /Re-authenticate/ }))
    await act(async () => check.resolve({ valid: false, error: "Bad credentials" }))

    expect(screen.queryByText(/no longer works/)).not.toBeInTheDocument()
    expect(recorded()).toEqual([{ status: "signed-out" }])
  })

  it("starts on the saved provider and instance when the provider picker is shown", async () => {
    renderInSession(
      (channel) => {
        if (channel === "gitlab:enumerate-hosts") return onlyHost("gitlab.com")
        if (channel === "gitlab:validate") return { valid: true, user: { login: "tanuki" } }
        return undefined
      },
      <GitAuth id="git" />,
      {
        status: "signed-in",
        block: "git",
        provider: "gitlab",
        host: "git.corp.example",
        instanceUrl: "https://git.corp.example",
        user: { login: "tanuki" },
        source: null,
        scopes: ["api"],
        tokenType: "pat",
        meta: null,
        outputs: {
          GITLAB_TOKEN: { value: "glpat-secret", sensitive: true },
          GIT_PROVIDER: { value: "gitlab", sensitive: false },
          __AUTHENTICATED: { value: "true", sensitive: false },
        },
      },
    )

    expect(screen.getByText(/Authenticated to GitLab \(git\.corp\.example\)/)).toBeInTheDocument()
    await waitFor(() => expect(callsTo("gitlab:validate")).toHaveLength(1))
    expect(callsTo("gitlab:validate")[0]).toEqual({
      useSessionToken: true,
      instanceUrl: "https://git.corp.example",
    })
    expect(publishedOutputs()).toMatchObject({ GITLAB_TOKEN: "glpat-secret" })
    expect(callsTo("github:validate")).toEqual([])
  })

  it("keeps the saved host out of another provider's hosts", async () => {
    renderInSession(
      (channel) => {
        if (channel === "github:enumerate-hosts") return onlyHost("github.com")
        if (channel === "gitlab:enumerate-hosts") return onlyHost("gitlab.com")
        if (channel === "github:validate") return { valid: true, user: { login: "octo" } }
        return undefined
      },
      <GitAuth id="git" detectCredentials={false} />,
      SAVED_GITHUB,
    )
    expect(await screen.findByRole("option", { name: "github.example.com" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Re-authenticate/ }))
    fireEvent.click(screen.getByRole("tab", { name: /GitLab/ }))
    await screen.findByPlaceholderText(/GitLab access token/i)
    await waitFor(() => expect(callsTo("gitlab:enumerate-hosts")).not.toHaveLength(0))

    expect(screen.queryByRole("option", { name: "github.example.com" })).not.toBeInTheDocument()
  })

  it.each([
    ["the scope it needs", ["repo"]],
    ["no scopes known", []],
  ])("warns of no missing scope for a saved sign-in with %s", async (_label, scopes) => {
    renderInSession(
      githubAnswers(() => deferred<unknown>().promise),
      <GitAuth id="git" />,
      { ...SAVED_GITHUB, scopes },
    )

    expect(screen.getByText(/Authenticated to GitHub/)).toBeInTheDocument()
    expect(screen.queryByText(/Missing "repo" scope/)).not.toBeInTheDocument()
  })

  it("lists the saved host once when enumeration lists it too", async () => {
    renderInSession(
      (channel) => {
        if (channel === "github:enumerate-hosts") {
          return {
            hosts: [
              { host: "github.com", sources: ["config"], hasCredential: true },
              { host: "github.example.com", sources: ["env"], hasCredential: true },
            ],
            defaultHost: "github.com",
          }
        }
        if (channel === "github:validate") return deferred<unknown>().promise
        return undefined
      },
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2))
    expect(screen.getAllByRole("option", { name: "github.example.com" })).toHaveLength(1)
  })

  it("shows the saved host as one with a credential, and no other source", async () => {
    renderInSession(
      githubAnswers(() => deferred<unknown>().promise),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("github.example.com"))
    expect(screen.getByTestId("host-credential-git")).toBeInTheDocument()
    expect(screen.queryByTestId("host-sources-git")).not.toBeInTheDocument()
    expect(screen.queryByTestId("host-no-credential-git")).not.toBeInTheDocument()
  })

  it("goes back to sign-in when the session's credential validates as no one", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: true })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    expect(
      await screen.findByText(
        "The session's GitHub credential now belongs to another user, not octo. Sign in again.",
      ),
    ).toBeInTheDocument()
  })

  it("goes back to sign-in when the saved credential is refused without a reason", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: false })),
      <GitAuth id="git" />,
      SAVED_GITHUB,
    )

    expect(
      await screen.findByText(
        "The sign-in saved with this session no longer works (the credential was refused). Sign in again.",
      ),
    ).toBeInTheDocument()
  })

  it("resumes a saved sign-in in a block locked to its provider", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: true, user: { login: "octo" } })),
      <GitHubAuth id="git" />,
      SAVED_GITHUB,
    )

    expect(screen.getByText(/Authenticated to GitHub \(github\.example\.com\)/)).toBeInTheDocument()
    await waitFor(() => expect(callsTo("github:validate")).toHaveLength(1))
  })

  it("ignores a saved sign-in for another provider when the block's provider is locked", async () => {
    const savedGitLab: SavedGitAuth = { ...SAVED_GITHUB, provider: "gitlab", host: "gitlab.com" }

    renderInSession(
      githubAnswers(() => ({ valid: true, user: { login: "octo" } })),
      <GitHubAuth id="git" detectCredentials={false} />,
      savedGitLab,
    )

    expect(await screen.findAllByRole("button", { name: /Sign in with GitHub/ })).not.toHaveLength(
      0,
    )
    expect(screen.queryByText(/Authenticated to/)).not.toBeInTheDocument()
    expect(callsTo("gitlab:validate")).toEqual([])
    expect(callsTo("github:validate")).toEqual([])
    expect(publishedOutputs()).toBeNull()
  })

  it("ignores a saved GitHub sign-in in a GitLab-locked block", async () => {
    renderInSession(
      (channel) => (channel === "gitlab:enumerate-hosts" ? onlyHost("gitlab.com") : undefined),
      <GitLabAuth id="git" detectCredentials={false} />,
      SAVED_GITHUB,
    )

    expect(await screen.findByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()
    expect(screen.queryByText(/Authenticated to/)).not.toBeInTheDocument()
    expect(callsTo("github:validate")).toEqual([])
    expect(callsTo("gitlab:validate")).toEqual([])
  })
})

describe("GitAuth in a session: a token that expires", () => {
  const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

  it("records when the token expires, and stays green while it is hours away", async () => {
    const expiresAt = inMinutes(8 * 60)
    renderInSession(
      (channel) => {
        if (channel === "github:enumerate-hosts") return onlyHost("github.com")
        if (channel === "github:env-credentials") {
          return {
            found: true,
            valid: true,
            user: { login: "octo" },
            envVar: "GITHUB_TOKEN",
            expiresAt,
          }
        }
        return undefined
      },
      <GitAuth id="git" />,
    )

    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toMatchObject({ status: "signed-in", expiresAt })
    expect(screen.getByTestId("git")).toHaveClass("bg-success-muted")
    expect(screen.queryByText(/These credentials/)).not.toBeInTheDocument()
  })

  it("turns red when a resumed token expires within minutes, and signs in again on request", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: true, user: { login: "octo" } })),
      <GitAuth id="git" />,
      { ...SAVED_GITHUB, expiresAt: inMinutes(3) },
    )

    const notice = (await screen.findByText("These credentials expire in less than 5 minutes"))
      .parentElement!.parentElement!
    expect(screen.getByTestId("git")).toHaveClass("bg-destructive-muted")

    fireEvent.click(within(notice).getByRole("button", { name: "Sign in again" }))

    await waitFor(() => expect(recorded()).toEqual([{ status: "signed-out" }]))
    expect(screen.queryByText(/These credentials/)).not.toBeInTheDocument()
    expect(publishedOutputs()).toEqual({ GIT_PROVIDER: "github" })
  })

  it("says the token expired when the host can't be reached to check it", async () => {
    renderInSession(
      githubAnswers(() => ({ valid: false, errorKind: "network", error: "offline" })),
      <GitAuth id="git" />,
      { ...SAVED_GITHUB, expiresAt: inMinutes(-10) },
    )

    expect(await screen.findByText("These credentials have expired")).toBeInTheDocument()
    expect(screen.getByText(/Authenticated to GitHub/)).toBeInTheDocument()
    expect(screen.getByTestId("git")).toHaveClass("bg-destructive-muted")
  })
})
