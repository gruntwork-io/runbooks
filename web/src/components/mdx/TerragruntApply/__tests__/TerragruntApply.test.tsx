import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useComponentIdRegistry, type BlockComponentType } from "@/contexts/ComponentIdRegistry"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { TerragruntPreflight } from "../../../../../../electron/shared/channels"
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
let checkState = "ENABLED"
const invoke = vi.fn((channel: string, _params?: unknown): Promise<unknown> => {
  switch (channel) {
    case "terragrunt-apply:preflight":
      return Promise.resolve(preflight)
    case "terragrunt-apply:plan":
      return Promise.resolve({ resources: [] })
    case "aws:send":
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

function renderBlock(
  props: Partial<React.ComponentProps<typeof TerragruntApply>> = {},
  blocks: { id: string; kind: BlockComponentType }[] = [
    { id: "repo", kind: "GitClone" },
    { id: "prod", kind: "AwsAuth" },
  ],
  below: { id: string; kind: BlockComponentType }[] = [],
) {
  return render(
    <TestWrapper>
      <Capture />
      {blocks.map((block) => (
        <Fake key={block.id} {...block} />
      ))}
      <TerragruntApply id="apply-budget" path="aws/prod/global/budget" auth={["prod"]} {...props} />
      {below.map((block) => (
        <Fake key={block.id} {...block} />
      ))}
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

  it("needs a gitCloneId when none of several clones is above it", async () => {
    renderBlock(
      {},
      [{ id: "prod", kind: "AwsAuth" }],
      [
        { id: "repo", kind: "GitClone" },
        { id: "other", kind: "GitClone" },
      ],
    )
    expect(await screen.findByText(/needs a gitCloneId/)).toBeInTheDocument()
  })

  it("takes the nearest clone above it when there are several", async () => {
    renderBlock(
      {},
      [
        { id: "repo", kind: "GitClone" },
        { id: "prod", kind: "AwsAuth" },
      ],
      [{ id: "other", kind: "GitClone" }],
    )
    expect(await screen.findByTestId("apply-budget")).toBeInTheDocument()
    expect(screen.queryByText(/needs a gitCloneId/)).not.toBeInTheDocument()
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
})
