import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"

// Mock config loading
let mockConfigReturn = {
  data: {
    variables: [
      { name: "region", type: "string", description: "AWS region", default: "us-east-1" },
    ],
    outputDependencies: [],
  } as Record<string, unknown> | null,
  isLoading: false,
  error: null as { message: string; details?: string } | null,
  refetch: vi.fn(),
  silentRefetch: vi.fn(),
}

vi.mock("@/hooks/useApiGetBoilerplateConfig", () => ({
  useApiGetBoilerplateConfig: () => mockConfigReturn,
}))

// Render IPC boundary: tests set data/error to simulate the outcome of the last
// render and inspect what autoRender was asked to render.
const renderMock = vi.hoisted(() => ({
  autoRender: vi.fn(),
  data: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
}))

vi.mock("@/hooks/useApiBoilerplateRender", () => ({
  useApiBoilerplateRender: () => ({
    data: renderMock.data,
    isLoading: false,
    error: renderMock.error,
    isAutoRendering: false,
    autoRender: renderMock.autoRender,
  }),
}))

import Template from "../Template"

function renderTemplate(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <Template id="test-template" path="templates/test" {...props} />
    </TestWrapper>,
  )
}

// Captures the live RunbookContext so tests can play the part of an upstream <Inputs> block.
let ctx: RunbookContextType
function CaptureContext() {
  ctx = useRunbookContext()
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

// Long enough for useFormState's 50 ms trailing debounce to fire.
async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 120)))
}

function renderedRegions() {
  return renderMock.autoRender.mock.calls.map(
    ([, vars]) => (vars as { inputs: Record<string, unknown> }).inputs.region,
  )
}

function formBlock(container: HTMLElement) {
  return container.querySelector(".runbook-block") as HTMLElement
}

describe("Template", () => {
  beforeEach(() => {
    mockConfigReturn = {
      data: {
        variables: [{ name: "region", type: "string", description: "AWS region", default: "us-east-1" }],
        outputDependencies: [],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      silentRefetch: vi.fn(),
    }
    renderMock.autoRender.mockReset()
    renderMock.data = null
    renderMock.error = null
  })

  it("renders with valid props", () => {
    renderTemplate()
    expect(screen.getByTestId("test-template")).toBeInTheDocument()
  })

  it("shows loading state", () => {
    mockConfigReturn = { ...mockConfigReturn, data: null, isLoading: true }
    renderTemplate()
    expect(screen.getByText("Loading template configuration...")).toBeInTheDocument()
  })

  it("shows error for missing path", () => {
    render(
      <TestWrapper>
        <Template id="test" path="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a 'path' prop/)).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <Template id="" path="templates/test" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("shows API error when config fails to load", () => {
    mockConfigReturn = {
      ...mockConfigReturn,
      data: null,
      isLoading: false,
      error: { message: "Template not found" },
    }
    renderTemplate()
    expect(screen.getByText(/Template not found/)).toBeInTheDocument()
  })

  describe("shared variables imported via inputsId", () => {
    beforeEach(() => {
      // "region" is also defined upstream, so it is a shared (read-only, live-synced) var.
      mockConfigReturn = {
        ...mockConfigReturn,
        data: {
          variables: [
            { name: "region", type: "string", description: "", default: "tpl-default", validations: [{ type: "required" }] },
            { name: "name", type: "string", description: "", default: "app" },
          ],
          outputDependencies: [],
        },
      }
    })

    async function renderAndGenerate(initialRegion: string) {
      const utils = render(
        <TestWrapper>
          <CaptureContext />
          <Template id="vpc" path="templates/vpc" inputsId="cfg" />
        </TestWrapper>,
      )
      setUpstreamRegion(initialRegion)
      await settle()
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      await settle()
      expect(renderedRegions()).toEqual([initialRegion])
      renderMock.autoRender.mockClear()
      return utils
    }

    it("renders once, with the new value, when a shared var changes upstream", async () => {
      await renderAndGenerate("us-east-1")

      setUpstreamRegion("eu-west-1")
      await settle()

      expect(renderedRegions()).toEqual(["eu-west-1"])
    })

    it("renders once when a required shared var is refilled upstream in one step", async () => {
      await renderAndGenerate("us-east-1")

      // Emptying a required var must not render at all (not even the old value).
      setUpstreamRegion("")
      await settle()
      expect(renderedRegions()).toEqual([])

      setUpstreamRegion("eu-west-1")
      await settle()
      expect(renderedRegions()).toEqual(["eu-west-1"])
    })
  })

  describe("generate outcome", () => {
    it("keeps the Generate button after a failed first render, and a retry renders again", async () => {
      const { container, rerender } = renderTemplate()
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(renderMock.autoRender).toHaveBeenCalledTimes(1)

      renderMock.error = { message: "template error" }
      rerender(
        <TestWrapper>
          <Template id="test-template" path="templates/test" />
        </TestWrapper>,
      )

      expect(screen.getByText(/template error/)).toBeInTheDocument()
      expect(formBlock(container).className).not.toContain("bg-success-muted")
      expect(screen.queryByText("Up to date")).toBeNull()

      // Same values as the failed render: the retry must still dispatch.
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(renderMock.autoRender).toHaveBeenCalledTimes(2)
    })

    it("turns green only after a render succeeds, and not while a later render has failed", () => {
      const { container, rerender } = renderTemplate()
      const rerenderTemplate = () =>
        rerender(
          <TestWrapper>
            <Template id="test-template" path="templates/test" />
          </TestWrapper>,
        )

      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(formBlock(container).className).not.toContain("bg-success-muted")

      renderMock.data = { fileTree: [] }
      rerenderTemplate()
      expect(formBlock(container).className).toContain("bg-success-muted")
      expect(screen.getByText("Up to date")).toBeInTheDocument()

      renderMock.error = { message: "template error" }
      rerenderTemplate()
      expect(formBlock(container).className).not.toContain("bg-success-muted")
      expect(screen.queryByText("Up to date")).toBeNull()
      expect(screen.getByText(/Generation failed/)).toBeInTheDocument()
    })
  })
})
