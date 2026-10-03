import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect, type ReactNode } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRunbookContext, flattenInputs } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import Inputs from "../Inputs"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// An Inputs block under the real session history provider. The mock boundary
// is the preload API (where an event leaves the renderer) and the loading of
// the boilerplate config.

const config: BoilerplateConfig = {
  variables: [
    { name: "region", type: "string", description: "AWS region", default: "us-east-1" },
    { name: "count", type: "int", description: "Instance count", default: 3 },
    { name: "enable_logging", type: "bool", description: "Enable logging", default: true },
  ],
  outputDependencies: [],
}

vi.mock("@/hooks/useApiGetBoilerplateConfig", () => ({
  useApiGetBoilerplateConfig: () => ({
    data: config,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    silentRefetch: vi.fn(),
  }),
}))

const DEFAULTS = { region: "us-east-1", count: 3, enable_logging: true }

const invoke = vi.fn(async () => ({ ok: true }))
const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI

/** The payload of each event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { blockId: string; kind: string; payload: unknown }])
    .filter(([channel]) => channel === "session:record-event")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "test-inputs", kind: "inputs" })
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
const registered = () => flattenInputs(runbook!.getInputs("test-inputs"))

/** A session whose history says the Inputs block was left as `saved`. */
function Session({ saved, children }: { saved?: unknown; children: ReactNode }) {
  const blockStates: SavedBlockState[] =
    saved === undefined ? [] : [{ blockId: "test-inputs", kind: "inputs", payload: saved }]
  return (
    <ApiProvider api={api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          <Capture />
          {children}
        </TestWrapper>
      </IpcSessionHistoryProvider>
    </ApiProvider>
  )
}

const field = (name: string) => screen.getByTestId(`field-${name}`).querySelector("input")!

/** Long enough for the form to have reported its initial values and any change. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 150)
    })
  })

describe("Inputs in a session", () => {
  beforeEach(() => {
    invoke.mockClear()
    runbook = undefined
  })

  it("starts from the values it was left with and, when it was submitted, registers them", async () => {
    const saved = { region: "eu-west-1", count: 5, enable_logging: false }

    render(
      <Session saved={{ values: saved, submitted: true }}>
        <Inputs id="test-inputs" path="boilerplate.yml" />
      </Session>,
    )

    expect(field("region")).toHaveValue("eu-west-1")
    expect(field("count")).toHaveValue(5)
    expect(field("enable_logging")).not.toBeChecked()
    await waitFor(() => expect(registered()).toEqual(saved))
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument()
  })

  it("keeps values that were typed and never submitted in the form, and registers the defaults", async () => {
    render(
      <Session saved={{ values: { ...DEFAULTS, region: "eu-we" }, submitted: false }}>
        <Inputs id="test-inputs" path="boilerplate.yml" />
      </Session>,
    )

    expect(field("region")).toHaveValue("eu-we")
    await waitFor(() => expect(registered()).toEqual(DEFAULTS))
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument()
  })

  it("starts a variable the history has no value for from its default", () => {
    render(
      <Session saved={{ values: { region: "eu-west-1", removed: "x" }, submitted: true }}>
        <Inputs id="test-inputs" path="boilerplate.yml" />
      </Session>,
    )

    expect(field("region")).toHaveValue("eu-west-1")
    expect(field("count")).toHaveValue(3)
  })

  it("adds nothing to the history until the user changes the form, then every change and the submit", async () => {
    const user = userEvent.setup()
    render(
      <Session>
        <Inputs id="test-inputs" path="boilerplate.yml" />
      </Session>,
    )
    await settle()
    expect(recorded()).toEqual([])

    await user.clear(field("region"))
    await user.type(field("region"), "eu-west-1")

    const edited = { ...DEFAULTS, region: "eu-west-1" }
    await waitFor(() => expect(recorded().at(-1)).toEqual({ values: edited, submitted: false }))

    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(recorded().at(-1)).toEqual({ values: edited, submitted: true }))
    await user.click(field("enable_logging"))
    await waitFor(() =>
      expect(recorded().at(-1)).toEqual({
        values: { ...edited, enable_logging: false },
        submitted: true,
      }),
    )
  })

  it("has an embedded Inputs as submitted, and adds nothing when it submits itself", async () => {
    const user = userEvent.setup()
    render(
      <Session>
        <Inputs id="test-inputs" path="boilerplate.yml" variant="embedded" />
      </Session>,
    )
    await settle()
    expect(recorded()).toEqual([])
    expect(registered()).toEqual(DEFAULTS)

    await user.type(field("region"), "a")

    await waitFor(() =>
      expect(recorded().at(-1)).toEqual({
        values: { ...DEFAULTS, region: "us-east-1a" },
        submitted: true,
      }),
    )
  })

  it("resumes from what was typed when it mounts again in the same session", async () => {
    const user = userEvent.setup()
    const session = (showInputs: boolean) => (
      <Session>{showInputs && <Inputs id="test-inputs" path="boilerplate.yml" />}</Session>
    )
    const { rerender } = render(session(true))
    await settle()
    await user.type(field("region"), "b")
    await waitFor(() => expect(recorded()).not.toEqual([]))

    // As a watch-mode reload does: the blocks unmount and mount again.
    rerender(session(false))
    rerender(session(true))

    expect(field("region")).toHaveValue("us-east-1b")
  })
})
