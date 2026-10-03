import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, type ReactNode } from "react"
import DirPicker from "../DirPicker"
import { DirPickerInstruction } from "../DirPickerInstruction"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// A DirPicker block under the real session history provider. The mock
// boundary is the preload API: workspace:dirs answers from TREE, and
// session:record-event is where an event leaves the renderer.
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

/** Directory tree served by the `workspace:dirs` stub, keyed by absolute path. */
const TREE: Record<string, string[]> = {
  "/root": ["dev", "prod"],
  "/root/dev": ["sandbox"],
  "/root/prod": ["us-east-1", "us-west-2"],
  "/root/prod/us-east-1": ["svc"],
}

const invoke = vi.fn(async (channel: string, params?: { worktreePath: string }) => {
  if (channel === "workspace:dirs") return { dirs: TREE[params!.worktreePath] ?? [] }
  return { ok: true }
})
const api = { invoke, on: () => () => {} } as unknown as RunbooksAPI

/** The payload of each `inputs` event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { blockId: string; kind: string; payload: unknown }])
    .filter(([channel]) => channel === "session:record-event")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "dp", kind: "inputs" })
      return event.payload
    })

/** Prints the `dp` block's registered output values so tests can read them. */
function PublishedOutputs() {
  const { blockOutputs } = useRunbookContext()
  return <pre data-testid="dp-outputs">{JSON.stringify(blockOutputs.dp?.values ?? null)}</pre>
}

const publishedValues = () => JSON.parse(screen.getByTestId("dp-outputs").textContent!)

/** Registers a GitClone-style `clone_path` output for block `clone`. */
function CloneOutput({ clonePath }: { clonePath: string }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs("clone", { clone_path: clonePath })
  }, [clonePath, registerOutputs])
  return null
}

/** A session whose history says the picker was left with `path`. */
function Session({ path, children }: { path?: string; children: ReactNode }) {
  const blockStates: SavedBlockState[] =
    path === undefined
      ? []
      : [{ blockId: "dp", kind: "inputs", payload: { values: { path }, submitted: true } }]
  return (
    <ApiProvider api={api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          {children}
          <PublishedOutputs />
        </TestWrapper>
      </IpcSessionHistoryProvider>
    </ApiProvider>
  )
}

const selects = () => screen.getAllByRole("combobox") as HTMLSelectElement[]
const pathInput = () => screen.getByRole("textbox") as HTMLInputElement

describe("DirPicker in a session", () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it("takes back the path it was left with, selecting each directory that is still there", async () => {
    render(
      <Session path="prod/us-east-1/custom">
        <DirPicker id="dp" rootDir="/root" />
      </Session>,
    )

    await waitFor(() => expect(pathInput()).toHaveValue("prod/us-east-1/custom"))
    // "custom" is not a directory under us-east-1: the path keeps it as typed.
    expect(selects().map((s) => s.value)).toEqual(["prod", "us-east-1", ""])
    expect(publishedValues()).toEqual({ PATH: "prod/us-east-1/custom" })
    expect(recorded()).toEqual([])
  })

  it("stops at the level limit and keeps the rest of the path", async () => {
    render(
      <Session path="prod/us-east-1/svc">
        <DirPicker id="dp" rootDir="/root" dirLabels={["Env", "Region"]} />
      </Session>,
    )

    await waitFor(() => expect(pathInput()).toHaveValue("prod/us-east-1/svc"))
    expect(selects().map((s) => s.value)).toEqual(["prod", "us-east-1"])
    expect(publishedValues()).toEqual({ PATH: "prod/us-east-1/svc" })
  })

  it("takes back the path once the GitClone block it browses has published its checkout", async () => {
    render(
      <Session path="dev/sandbox">
        <CloneOutput clonePath="/root" />
        <DirPicker id="dp" gitCloneId="clone" />
      </Session>,
    )

    await waitFor(() => expect(pathInput()).toHaveValue("dev/sandbox"))
    expect(selects().map((s) => s.value)).toEqual(["dev", "sandbox"])
    expect(publishedValues()).toEqual({ PATH: "dev/sandbox" })
  })

  it("adds every pick and every edit of the path to the history", async () => {
    render(
      <Session>
        <DirPicker id="dp" rootDir="/root" />
      </Session>,
    )
    await waitFor(() => expect(selects()).toHaveLength(1))

    await act(async () => {
      fireEvent.change(selects()[0]!, { target: { value: "prod" } })
    })
    await waitFor(() => expect(selects()).toHaveLength(2))
    await act(async () => {
      fireEvent.change(selects()[1]!, { target: { value: "us-west-2" } })
    })
    fireEvent.change(pathInput(), { target: { value: "prod/us-west-2/app" } })

    expect(recorded()).toEqual([
      { values: { path: "prod" }, submitted: true },
      { values: { path: "prod/us-west-2" }, submitted: true },
      { values: { path: "prod/us-west-2/app" }, submitted: true },
    ])
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: "prod/us-west-2/app" }))
  })

  it("starts with no path when the history has none", async () => {
    render(
      <Session>
        <DirPicker id="dp" rootDir="/root" />
      </Session>,
    )
    await waitFor(() => expect(selects()).toHaveLength(1))

    expect(pathInput()).toHaveValue("")
    expect(selects()[0]!.value).toBe("")
    expect(publishedValues()).toBeNull()
  })
})

describe("DirPicker in instruction mode, in a session", () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it("starts from the path the history has, publishes it, and records edits", async () => {
    render(
      <Session path="prod/us-east-1">
        <DirPickerInstruction id="dp" rootDir="/root" />
      </Session>,
    )

    expect(pathInput()).toHaveValue("prod/us-east-1")
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: "prod/us-east-1" }))
    expect(recorded()).toEqual([])

    fireEvent.change(pathInput(), { target: { value: "dev" } })

    expect(recorded()).toEqual([{ values: { path: "dev" }, submitted: true }])
    await waitFor(() => expect(publishedValues()).toEqual({ PATH: "dev" }))
  })
})
