import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect, type ReactNode } from "react"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// The real block and useGitPullRequest under the real session history
// provider. The mock boundary is the preload API: the fake emits the git:*
// events main sends before resolving the create invoke, and
// session:record-event is where the block's history leaves the renderer.

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: {
      id: "wt",
      localPath: "/work/infra",
      gitInfo: {
        repoUrl: "https://github.com/acme/infra.git",
        repoOwner: "acme",
        repoName: "infra",
        ref: "main",
      },
    },
    workTrees: [],
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
  }),
}))

vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({ changes: [], isLoading: false, error: null, refetch: vi.fn() }),
}))

// The form and result panels are not under test: keep the fields the block
// owns, and the actions.
vi.mock("../components/PRForm", () => ({
  PRForm: (props: {
    prTitle: string
    setPRTitle: (v: string) => void
    prDescription: string
    setPRDescription: (v: string) => void
    branchName: string
    setBranchName: (v: string) => void
    commitMessage: string
    setCommitMessage: (v: string) => void
    selectedLabels: string[]
    setSelectedLabels: (labels: string[]) => void
    onSubmit: () => void
    disabled: boolean
  }) => (
    <div>
      <input
        aria-label="Title"
        value={props.prTitle}
        onChange={(e) => props.setPRTitle(e.target.value)}
      />
      <input
        aria-label="Description"
        value={props.prDescription}
        onChange={(e) => props.setPRDescription(e.target.value)}
      />
      <input
        aria-label="Branch"
        value={props.branchName}
        onChange={(e) => props.setBranchName(e.target.value)}
      />
      <input
        aria-label="Commit message"
        value={props.commitMessage}
        onChange={(e) => props.setCommitMessage(e.target.value)}
      />
      <div data-testid="labels">{props.selectedLabels.join(",")}</div>
      <button type="button" onClick={() => props.setSelectedLabels(["bug"])}>
        Label bug
      </button>
      <button type="button" onClick={props.onSubmit} disabled={props.disabled}>
        Submit
      </button>
    </div>
  ),
}))
vi.mock("../components/PRResult", () => ({
  PRResultDisplay: ({
    result,
    onCreateAnother,
  }: {
    result: { prUrl: string }
    onCreateAnother: () => void
  }) => (
    <div>
      <div>Opened {result.prUrl}</div>
      <button type="button" onClick={onCreateAnother}>
        Create another
      </button>
    </div>
  ),
}))

import GitPullRequest from "../GitPullRequest"

type Api = Parameters<typeof ApiProvider>[0]["api"]

const PR_URL = "https://github.com/acme/infra/pull/42"
const RESULT = { prUrl: PR_URL, prNumber: 42, branchName: "runbook/1" }
const OUTPUTS = { PR_ID: "42", PR_URL }
const CREATED = { status: "created", result: RESULT, outputs: OUTPUTS }

let listeners: Map<string, Set<(data: unknown) => void>>
let invoke: ReturnType<typeof vi.fn>

function emit(channel: string, data: unknown) {
  for (const cb of listeners.get(channel) ?? []) cb(data)
}

/** The payload of each `kind` event sent to the main process, oldest first. */
const recorded = (kind: string) =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { blockId: string; kind: string; payload: unknown }])
    .filter(([channel, event]) => channel === "session:record-event" && event.kind === kind)
    .map(([, event]) => {
      expect(event.blockId).toBe("pr")
      return event.payload
    })

let runbook: RunbookContextType | undefined
function Capture() {
  const value = useRunbookContext()
  useEffect(() => {
    runbook = value
  })
  return null
}

/** Registers the Inputs block "cfg" with `env`, as <Inputs> does once it is submitted. */
function RegisterEnv({ env }: { env: string | undefined }) {
  const { registerInputs } = useRunbookContext()
  useEffect(() => {
    if (env === undefined) return
    registerInputs(
      "cfg",
      { env },
      {
        variables: [{ name: "env", description: "", type: BoilerplateVariableType.String }],
      },
    )
  }, [env, registerInputs])
  return null
}

/** A session whose history has `blockStates` for the block. */
function renderBlock(blockStates: SavedBlockState[] = [], env?: string) {
  listeners = new Map()
  invoke = vi.fn(async (channel: string) => {
    if (channel === "git:pull-request") {
      emit("git:pr-result", RESULT)
      emit("git:outputs", { outputs: OUTPUTS })
      emit("git:status", { status: "success", exitCode: 0 })
      return { url: PR_URL, number: 42 }
    }
    if (channel === "github:labels") return { labels: [] }
    return { ok: true }
  })
  const api = {
    invoke,
    on: (channel: string, cb: (data: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)?.delete(cb)
    },
  } as unknown as Api

  const ui = (currentEnv: string | undefined): ReactNode => (
    <ApiProvider api={api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          <Capture />
          <RegisterEnv env={currentEnv} />
          <GitPullRequest
            id="pr"
            provider="github"
            inputsId="cfg"
            prefilledPullRequestTitle="Deploy {{ .inputs.env }}"
            prefilledPullRequestDescription="Changes for {{ .inputs.env }}"
            prefilledBranchName="runbook/1"
          />
        </TestWrapper>
      </IpcSessionHistoryProvider>
    </ApiProvider>
  )
  const utils = render(ui(env))
  return { ...utils, setEnv: (next: string) => utils.rerender(ui(next)) }
}

const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      }),
  )

describe("GitPullRequest in a session", () => {
  beforeEach(() => {
    runbook = undefined
  })

  it("starts on the request it opened, with its outputs, and records nothing", async () => {
    renderBlock([{ blockId: "pr", kind: "pull-request", payload: CREATED }])

    expect(await screen.findByText(`Opened ${PR_URL}`)).toBeInTheDocument()
    await waitFor(() => expect(runbook?.blockOutputs.pr?.values).toEqual(OUTPUTS))
    await settle()
    expect(recorded("pull-request")).toEqual([])
    expect(recorded("inputs")).toEqual([])
  })

  it("records a request it opens", async () => {
    renderBlock([], "staging")
    const submit = await screen.findByRole("button", { name: "Submit" })
    await waitFor(() => expect(submit).toBeEnabled())

    fireEvent.click(submit)

    expect(await screen.findByText(`Opened ${PR_URL}`)).toBeInTheDocument()
    await waitFor(() => expect(recorded("pull-request")).toEqual([CREATED]))
  })

  it("records that a request was set aside, and a blank form, on Create another", async () => {
    renderBlock([{ blockId: "pr", kind: "pull-request", payload: CREATED }])

    fireEvent.click(await screen.findByRole("button", { name: "Create another" }))

    expect(await screen.findByRole("button", { name: "Submit" })).toBeInTheDocument()
    expect(recorded("pull-request")).toEqual([{ status: "none" }])
    expect(recorded("inputs")).toEqual([{ values: {}, submitted: false }])
  })

  it("records only the fields the user edited", async () => {
    renderBlock()

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Mine" } })
    fireEvent.click(screen.getByRole("button", { name: "Label bug" }))

    expect(recorded("inputs")).toEqual([
      { values: { title: "Mine" }, submitted: false },
      { values: { title: "Mine", labels: ["bug"] }, submitted: false },
    ])
  })

  it("restores the fields the user edited, and keeps them over template values that resolve later", async () => {
    const { setEnv } = renderBlock([
      {
        blockId: "pr",
        kind: "inputs",
        payload: { values: { title: "Mine", labels: ["bug"] }, submitted: false },
      },
    ])
    expect(await screen.findByLabelText("Title")).toHaveValue("Mine")
    expect(screen.getByTestId("labels")).toHaveTextContent("bug")

    setEnv("prod")

    // The description was never edited, so it follows the resolved template.
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue("Changes for prod"),
    )
    expect(screen.getByLabelText("Title")).toHaveValue("Mine")
    expect(recorded("inputs")).toEqual([])
  })
})
