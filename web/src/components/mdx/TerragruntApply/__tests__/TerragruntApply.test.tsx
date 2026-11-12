import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useComponentIdRegistry, type BlockComponentType } from "@/contexts/ComponentIdRegistry"
import { SimulationContext, type SimulationContextValue } from "@/contexts/SimulationContext.types"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { TerragruntPreflight } from "../../../../../../electron/shared/channels"
import type { PlanResult } from "../../../../../../src/domain/terragrunt/run"
import type { TfModuleSpec } from "../../../../../../src/domain/tf-module/types"
import TerragruntApply from "../TerragruntApply"

const CLONE = {
  id: "repo",
  repoUrl: "https://github.com/acme/infra-live",
  localPath: "/clones/infra-live",
  gitInfo: {
    ref: "main",
    refType: "branch",
    commit: "abc",
    repoOwner: "acme",
    repoName: "infra-live",
  },
}
let workTrees = [CLONE]
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({ activeWorkTree: workTrees[0] ?? null, workTrees }),
}))

let preflight: TerragruntPreflight
let planResult: PlanResult = { resources: [] }
let checkState = "ENABLED"
const invoke = vi.fn((channel: string, _params?: unknown): Promise<unknown> => {
  switch (channel) {
    case "terragrunt-apply:preflight":
      return Promise.resolve(preflight)
    case "terragrunt-apply:plan":
      return Promise.resolve(planResult)
    case "aws:send":
    case "simulation:respond":
      return Promise.resolve({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ state: checkState }),
      })
    default:
      return Promise.reject(new Error(`unexpected channel ${channel}`))
  }
})
const api = { invoke, on: () => () => {} }
vi.mock("@/contexts/ApiContext", () => ({ useApi: () => api }))

const TOOLS = [
  { command: "terragrunt", found: true, version: "0.99.0", install: "" },
  { command: "tofu", found: true, version: "1.10.0", install: "" },
]

/** A module with one check, in a group AwsAuth sends. */
const moduleWithCheck = {
  title: "Budget",
  providers: [],
  outputs: [],
  variables: [],
  warnings: [],
  authGroups: [],
  definitions: {
    groups: { aws: { name: "aws", auth: "AwsAuth", scopes: [] } },
    lookups: {},
    checks: {
      "aws.enabled": {
        id: "aws.enabled",
        group: "aws",
        name: "enabled",
        params: [],
        request: { method: "GET", url: "https://iam.amazonaws.com/", headers: {} },
        expect: { path: "state", equals: "ENABLED" },
        message: "Budgets are off in {{ .auth.accountId }}.",
        source: "runbook_block.yml",
      },
    },
  },
  preflight: [{ from: "aws.enabled", with: {} }],
} as unknown as TfModuleSpec

/** Stands in for another block, registered under its kind. */
function Fake({ id, kind }: { id: string; kind: BlockComponentType }) {
  const ref = useRef<HTMLDivElement>(null)
  useComponentIdRegistry(id, kind, ref)
  return <div ref={ref} />
}

let ctx: RunbookContextType | undefined
function Capture() {
  const runbook = useRunbookContext()
  useEffect(() => {
    ctx = runbook
  }, [runbook])
  return null
}

const SIMULATING: SimulationContextValue = {
  state: { enabled: true, scenarios: [], active: "happy" },
  setScenario: () => {},
  revision: 1,
}
const NOT_SIMULATING: SimulationContextValue = { ...SIMULATING, state: { enabled: false } }

function renderBlock(
  props: Partial<React.ComponentProps<typeof TerragruntApply>> = {},
  blocks: { id: string; kind: BlockComponentType }[] = [
    { id: "repo", kind: "GitClone" },
    { id: "prod", kind: "AwsAuth" },
  ],
  simulating: boolean | SimulationContextValue = false,
) {
  const simulation =
    typeof simulating === "object" ? simulating : simulating ? SIMULATING : NOT_SIMULATING
  return render(
    <TestWrapper>
      <SimulationContext.Provider value={simulation}>
        <Capture />
        {blocks.map((block) => (
          <Fake key={block.id} {...block} />
        ))}
        <TerragruntApply
          id="apply-budget"
          path="aws/prod/global/budget"
          auth={["prod"]}
          {...props}
        />
      </SimulationContext.Provider>
    </TestWrapper>,
  )
}

async function signIn() {
  await waitFor(() => expect(ctx).toBeDefined())
  act(() => {
    ctx!.registerOutputs("prod", {
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "us-east-2",
      AWS_SESSION_TOKEN: "",
      AWS_ACCOUNT_ID: "111122223333",
    })
  })
}

const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)

describe("TerragruntApply", () => {
  beforeEach(() => {
    ctx = undefined
    workTrees = [CLONE]
    checkState = "ENABLED"
    preflight = { kind: "ready", tools: TOOLS, inputs: {} }
    planResult = { resources: [] }
    invoke.mockClear()
  })

  it("waits for the outputs its path reads", () => {
    renderBlock({ path: "{{ .outputs.group.CODE_PATH }}" })
    expect(screen.getByText("Waiting for outputs from:")).toBeInTheDocument()
  })

  it("needs a GitClone block, and a gitCloneId when there are several", async () => {
    renderBlock({}, [{ id: "prod", kind: "AwsAuth" }])
    expect(await screen.findByText(/needs a <GitClone> block/)).toBeInTheDocument()
  })

  it("needs a gitCloneId when the runbook has several clones", async () => {
    renderBlock({}, [
      { id: "repo", kind: "GitClone" },
      { id: "other", kind: "GitClone" },
      { id: "prod", kind: "AwsAuth" },
    ])
    expect(await screen.findByText(/needs a gitCloneId/)).toBeInTheDocument()
  })

  it("refuses an auth list with a block that isn't an auth block, or two of one kind", async () => {
    const { unmount } = renderBlock({ auth: ["repo"] })
    expect(await screen.findByText(/"repo", which isn't an auth block/)).toBeInTheDocument()
    unmount()
    renderBlock({ auth: ["prod", "staging"] }, [
      { id: "repo", kind: "GitClone" },
      { id: "prod", kind: "AwsAuth" },
      { id: "staging", kind: "AwsAuth" },
    ])
    expect(await screen.findByText(/two AwsAuth blocks/)).toBeInTheDocument()
  })

  it("asks for a sign-in before it plans", async () => {
    renderBlock()
    expect(await screen.findByText(/above to plan/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Plan/ })).not.toBeInTheDocument()
  })

  it("runs the preflight, then plans with the auth block's credentials, and says who it runs as", async () => {
    renderBlock()
    await signIn()
    expect(await screen.findByText("AWS account 111122223333 in us-east-2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))

    await waitFor(() => expect(calls("terragrunt-apply:plan")).toHaveLength(1))
    expect(calls("terragrunt-apply:preflight")[0]![1]).toEqual({
      blockId: "apply-budget",
      worktreePath: "/clones/infra-live",
      path: "aws/prod/global/budget",
      env: {
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "us-east-2",
        AWS_SESSION_TOKEN: "",
      },
    })
    expect(await screen.findByText(/Preflight passed/)).toBeInTheDocument()
  })

  it("publishes the state's outputs when a plan changes nothing", async () => {
    planResult = {
      resources: [],
      outputs: [
        { name: "budget_name", value: "prod-monthly", sensitive: false },
        { name: "token", value: "t0k3n", sensitive: true },
      ],
    }
    renderBlock()
    await signIn()
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }))
    await waitFor(() => expect(ctx!.blockOutputs["apply_budget"]).toBeDefined())
    expect(ctx!.blockOutputs["apply_budget"]!.values.budget_name).toBe("prod-monthly")
    expect(ctx!.blockOutputs["apply_budget"]!.values.token).not.toBe("t0k3n")
  })

  it("doesn't plan while the clone has changes that aren't pushed", async () => {
    preflight = {
      kind: "unpushed",
      tools: TOOLS,
      message: "The clone has a change that isn't pushed.",
    }
    renderBlock()
    await signIn()
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }))
    expect(await screen.findByText("Push the changes first")).toBeInTheDocument()
    expect(calls("terragrunt-apply:plan")).toHaveLength(0)
  })

  it("runs the module's checks through the auth block of their kind, and stops on a failure", async () => {
    checkState = "DISABLED"
    preflight = { kind: "ready", tools: TOOLS, inputs: {}, module: moduleWithCheck }
    renderBlock()
    await signIn()
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }))

    expect(await screen.findByText("Budgets are off in 111122223333.")).toBeInTheDocument()
    expect(calls("aws:send")).toHaveLength(1)
    expect(calls("terragrunt-apply:plan")).toHaveLength(0)
  })

  it("says when the auth list has no block of the kind a check needs", async () => {
    preflight = { kind: "ready", tools: TOOLS, inputs: {}, module: moduleWithCheck }
    renderBlock({ auth: [] })
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }))
    expect(await screen.findByText(/need an AwsAuth block/)).toBeInTheDocument()
    expect(calls("terragrunt-apply:plan")).toHaveLength(0)
  })

  it("in simulation, plans with no clone and no sign-in, and answers checks from simulation.yml", async () => {
    workTrees = []
    preflight = { kind: "ready", tools: [], inputs: {}, module: moduleWithCheck }
    renderBlock({}, undefined, true)
    expect(await screen.findByText(/simulated for/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))

    await waitFor(() => expect(calls("terragrunt-apply:plan")).toHaveLength(1))
    expect(calls("simulation:respond")[0]![1]).toEqual({ id: "aws.enabled", with: {} })
    expect(await screen.findByText("Preflight passed: 1 check.")).toBeInTheDocument()
    expect(calls("aws:send")).toHaveLength(0)
    expect(calls("terragrunt-apply:preflight")[0]![1]).toMatchObject({
      worktreePath: "",
      blockInputs: {},
    })
  })

  it("runs for real, sign-in and checks included, when the scenario runs what it doesn't answer", async () => {
    preflight = { kind: "ready", tools: TOOLS, inputs: {}, module: moduleWithCheck }
    const realRun = (units: string[], responses: string[]): SimulationContextValue =>
      ({
        ...SIMULATING,
        state: {
          ...SIMULATING.state,
          answers: { runUnanswered: true, units, responses, scripts: [] },
        },
      }) as SimulationContextValue
    renderBlock({}, undefined, realRun(["apply-account"], ["google.domains"]))
    expect(await screen.findByText(/above to plan/)).toBeInTheDocument()
    await signIn()
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }))

    await waitFor(() => expect(calls("terragrunt-apply:plan")).toHaveLength(1))
    expect(calls("aws:send")).toHaveLength(1)
    expect(calls("simulation:respond")).toHaveLength(0)
    expect(screen.queryByText(/simulated for/)).not.toBeInTheDocument()
    expect(screen.getByText(/Runs for real/)).toBeInTheDocument()
  })

  it("is simulated, checks included, when the scenario answers it, though it runs the rest for real", async () => {
    workTrees = []
    preflight = { kind: "ready", tools: [], inputs: {}, module: moduleWithCheck }
    renderBlock({}, undefined, {
      ...SIMULATING,
      state: {
        ...SIMULATING.state,
        answers: { runUnanswered: true, units: ["apply-budget"], responses: [], scripts: [] },
      },
    } as SimulationContextValue)
    expect(await screen.findByText(/simulated for/)).toBeInTheDocument()
    expect(screen.queryByText(/Runs for real/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))

    await waitFor(() => expect(calls("terragrunt-apply:plan")).toHaveLength(1))
    expect(calls("simulation:respond")[0]![1]).toMatchObject({ id: "aws.enabled" })
    expect(calls("aws:send")).toHaveLength(0)
  })
})
