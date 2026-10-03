import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect, type ReactNode } from "react"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// A Template block under the real session history provider. The mock boundary
// is the preload API (where an event leaves the renderer), the loading of the
// boilerplate config, and the render that writes the files.

// "region" is also registered by the upstream "cfg" block, so the Template
// imports it. "name" is the Template's own.
const configReturn = vi.hoisted(() => ({
  data: {
    variables: [
      { name: "region", type: "string", description: "", default: "tpl-default" },
      { name: "name", type: "string", description: "", default: "app" },
    ],
    outputDependencies: [],
  },
  isLoading: false,
  error: null,
  refetch: () => {},
  silentRefetch: () => {},
}))
vi.mock("@/hooks/useApiGetBoilerplateConfig", () => ({
  useApiGetBoilerplateConfig: () => configReturn,
}))

const autoRender = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/useApiBoilerplateRender", () => ({
  useApiBoilerplateRender: () => ({
    data: null,
    isLoading: false,
    error: null,
    isAutoRendering: false,
    autoRender,
  }),
}))

const mode = vi.hoisted(() => ({ instruction: false }))
vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: mode.instruction, setEnabled: () => {} }),
}))

import Template from "../Template"

const invoke = vi.fn(async () => ({ ok: true }))
const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI

/** The payload of each `kind` event sent to the main process, oldest first. */
const recorded = (kind = "inputs") =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { kind: string; payload: unknown }])
    .filter(([channel, event]) => channel === "session:record-event" && event.kind === kind)
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "vpc" })
      return event.payload
    })

let ctx: RunbookContextType
function CaptureContext() {
  const value = useRunbookContext()
  useEffect(() => {
    ctx = value
  })
  return null
}

const upstreamConfig: BoilerplateConfig = {
  variables: [{ name: "region", type: "string", description: "" }],
}

function setUpstreamRegion(region: string) {
  act(() => {
    ctx.registerInputs("cfg", { region }, upstreamConfig)
  })
}

/**
 * A session whose history says the Template's form was left as `saved`, and
 * that it last wrote what `written` hashes to.
 */
function Session({
  saved,
  written,
  children,
}: {
  saved?: unknown
  written?: unknown
  children?: ReactNode
}) {
  const blockStates: SavedBlockState[] = [
    ...(saved === undefined ? [] : [{ blockId: "vpc", kind: "inputs" as const, payload: saved }]),
    ...(written === undefined
      ? []
      : [{ blockId: "vpc", kind: "render" as const, payload: written }]),
  ]
  return (
    <ApiProvider api={api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          <CaptureContext />
          {children}
        </TestWrapper>
      </IpcSessionHistoryProvider>
    </ApiProvider>
  )
}

const field = (container: HTMLElement, name: string) =>
  container.querySelector(`#vpc-${name}`) as HTMLInputElement

// Long enough for useFormState's 50 ms trailing debounce to fire.
const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 120)
      }),
  )

describe("Template in a session", () => {
  beforeEach(() => {
    invoke.mockClear()
    autoRender.mockClear()
    mode.instruction = false
  })

  it("starts from the values it was left with, and writes nothing until Generate is pressed", async () => {
    const { container } = render(
      <Session saved={{ values: { name: "billing" }, submitted: false }}>
        <Template id="vpc" path="templates/vpc" />
      </Session>,
    )
    await settle()

    expect(field(container, "name")).toHaveValue("billing")
    expect(field(container, "region")).toHaveValue("tpl-default")
    expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument()
    expect(autoRender).not.toHaveBeenCalled()
    expect(recorded()).toEqual([])
  })

  /** Generate with `name`, and return the render event that wrote the files. */
  async function generateOnce(name: string): Promise<unknown> {
    const { container, unmount } = render(
      <Session>
        <Template id="vpc" path="templates/vpc" />
      </Session>,
    )
    await settle()
    fireEvent.change(field(container, "name"), { target: { value: name } })
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    await settle()
    expect(autoRender).toHaveBeenCalledTimes(1)
    const written = recorded("render").at(-1)
    expect(written).toEqual({ writtenHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    unmount()
    invoke.mockClear()
    autoRender.mockClear()
    return written
  }

  it("resumes as generated, and does not write files that would come out as they were written", async () => {
    const written = await generateOnce("billing")

    const { container } = render(
      <Session saved={{ values: { name: "billing" }, submitted: true }} written={written}>
        <Template id="vpc" path="templates/vpc" />
      </Session>,
    )
    await settle()

    expect(field(container, "name")).toHaveValue("billing")
    expect(screen.queryByRole("button", { name: "Generate" })).not.toBeInTheDocument()
    expect(autoRender).not.toHaveBeenCalled()

    // A change writes, as in any generated Template.
    fireEvent.change(field(container, "name"), { target: { value: "payments" } })
    await settle()
    expect(autoRender).toHaveBeenCalledTimes(1)
    expect(autoRender.mock.calls[0]![1]).toMatchObject({ inputs: { name: "payments" } })
  })

  it("writes the files when they would come out differently than they were written", async () => {
    const written = await generateOnce("billing")

    // The values changed since: the form was left with one the files never had.
    render(
      <Session saved={{ values: { name: "payments" }, submitted: true }} written={written}>
        <Template id="vpc" path="templates/vpc" />
      </Session>,
    )
    await settle()

    expect(autoRender).toHaveBeenCalledTimes(1)
    expect(autoRender.mock.calls[0]![1]).toMatchObject({ inputs: { name: "payments" } })
    expect(recorded("render")).toHaveLength(1)
  })

  it("adds its own values to the history when they change or files are generated, and leaves imported ones out", async () => {
    const { container } = render(
      <Session>
        <Template id="vpc" path="templates/vpc" inputsId="cfg" />
      </Session>,
    )
    setUpstreamRegion("us-east-1")
    await settle()
    // Mounting, and a value arriving from the block it is imported from, are
    // not the user acting on this form.
    expect(recorded()).toEqual([])

    fireEvent.change(field(container, "name"), { target: { value: "billing" } })
    await settle()
    expect(recorded()).toEqual([{ values: { name: "billing" }, submitted: false }])

    setUpstreamRegion("eu-west-1")
    await settle()
    expect(recorded()).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    await settle()
    expect(recorded().at(-1)).toEqual({ values: { name: "billing" }, submitted: true })
  })

  it("carries the values over a switch to instruction mode and back", async () => {
    const tree = () => (
      <Session>
        <Template id="vpc" path="templates/vpc" />
      </Session>
    )
    const { container, rerender } = render(tree())
    await settle()
    fireEvent.change(field(container, "name"), { target: { value: "billing" } })
    await settle()

    mode.instruction = true
    rerender(tree())
    await settle()
    expect(screen.getByText(/boilerplate --template-url/).textContent).toContain(
      "--var 'name=billing'",
    )
    fireEvent.change(field(container, "name"), { target: { value: "payments" } })
    await settle()
    expect(recorded().at(-1)).toEqual({
      values: { region: "tpl-default", name: "payments" },
      submitted: false,
    })

    mode.instruction = false
    rerender(tree())
    await settle()
    expect(field(container, "name")).toHaveValue("payments")
  })
})
