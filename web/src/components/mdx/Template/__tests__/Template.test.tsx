import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"
import type React from "react"
import { useEffect } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { sensitiveOutput } from "@/lib/outputValues"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"

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
// render and inspect what render was asked to render.
const renderMock = vi.hoisted(() => ({
  render: vi.fn(),
  data: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
}))

vi.mock("@/hooks/useApiBoilerplateRender", () => ({
  useApiBoilerplateRender: () => ({
    data: renderMock.data,
    isLoading: false,
    error: renderMock.error,
    render: renderMock.render,
  }),
}))

import Template from "../Template"

function testTemplate() {
  return (
    <TestWrapper>
      <CaptureContext />
      <Template id="test-template" path="templates/test" />
    </TestWrapper>
  )
}

function renderTemplate() {
  return render(testTemplate())
}

// Captures the live RunbookContext so tests can play the part of an upstream <Inputs> block.
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

function renderedRegions() {
  return renderMock.render.mock.calls.map(
    ([vars]) => (vars as { inputs: Record<string, unknown> }).inputs.region,
  )
}

// Plays the last requested render succeeding: the hook returns its result on
// the next render of the tree.
function succeedRender(rerender: (ui: React.ReactElement) => void, tree: React.ReactElement) {
  renderMock.data = { fileTree: [] }
  rerender(tree)
}

// Gives the linked-default resolution time to come back.
async function settle() {
  await act(
    () =>
      new Promise((resolve) => {
        setTimeout(resolve, 120)
      }),
  )
}

function formBlock(container: HTMLElement) {
  return container.querySelector(".runbook-block") as HTMLElement
}

describe("Template", () => {
  beforeEach(() => {
    mockConfigReturn = {
      data: {
        variables: [
          { name: "region", type: "string", description: "AWS region", default: "us-east-1" },
        ],
        outputDependencies: [],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      silentRefetch: vi.fn(),
    }
    renderMock.render.mockReset()
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
            {
              name: "region",
              type: "string",
              description: "",
              default: "tpl-default",
              required: true,
              validations: [{ type: "required" }],
            },
            { name: "name", type: "string", description: "", default: "app" },
          ],
          outputDependencies: [],
        },
      }
    })

    const vpcTemplate = () => (
      <TestWrapper>
        <CaptureContext />
        <Template id="vpc" path="templates/vpc" inputsId="cfg" />
      </TestWrapper>
    )

    function renderAndGenerate(initialRegion: string) {
      const utils = render(vpcTemplate())
      setUpstreamRegion(initialRegion)
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(renderedRegions()).toEqual([initialRegion])
      renderMock.render.mockClear()
      succeedRender(utils.rerender, vpcTemplate())
      return utils
    }

    it("goes stale without rendering when a shared var changes upstream, and Regenerate renders the new value", () => {
      const { container } = renderAndGenerate("us-east-1")
      expect(formBlock(container).className).toContain("bg-success-muted")

      setUpstreamRegion("eu-west-1")
      expect(renderedRegions()).toEqual([])
      expect(formBlock(container).className).toContain("bg-warning-muted")

      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))
      expect(renderedRegions()).toEqual(["eu-west-1"])
      expect(formBlock(container).className).toContain("bg-success-muted")
    })

    it("does not regenerate while a required shared var is empty upstream", () => {
      renderAndGenerate("us-east-1")

      setUpstreamRegion("")
      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))
      expect(renderedRegions()).toEqual([])

      setUpstreamRegion("eu-west-1")
      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))
      expect(renderedRegions()).toEqual(["eu-west-1"])
    })
  })

  // A linked default can use what the Template imports through inputsId, even
  // a variable its own boilerplate.yml doesn't declare. A variable the
  // upstream block marks sensitive is never sent to work one out.
  describe("linked defaults over imported values", () => {
    it("shows what a default built from an imported value comes to", async () => {
      mockConfigReturn = {
        ...mockConfigReturn,
        data: {
          variables: [
            { name: "bucket", type: "string", description: "", default: "{{ .region }}-state" },
            { name: "auth", type: "string", description: "", default: "Bearer {{ .token }}" },
          ],
          outputDependencies: [],
        },
      }
      // Resolves the two defaults when their variable is sent, as main would.
      const invoke = vi.fn(
        async (channel: string, request: { inputs: Record<string, unknown> }) => {
          if (channel !== "boilerplate:resolve-inputs") return undefined
          const { region, token } = request.inputs
          return {
            inputs: {
              ...request.inputs,
              ...(typeof region === "string" && { bucket: `${region}-state` }),
              ...(typeof token === "string" && { auth: `Bearer ${token}` }),
            },
          }
        },
      )
      render(
        <ApiProvider api={{ invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI}>
          <TestWrapper>
            <CaptureContext />
            <Template id="state" path="templates/state" inputsId="cfg" />
          </TestWrapper>
        </ApiProvider>,
      )

      act(() => {
        ctx.registerInputs(
          "cfg",
          { region: "eu-west-1", token: "ghp_s3cr3t" },
          {
            variables: [
              { name: "region", type: "string", description: "" },
              { name: "token", type: "string", description: "", sensitive: true },
            ],
          },
        )
      })
      await settle()

      expect(screen.getByLabelText("Bucket")).toHaveTextContent("eu-west-1-state")
      expect(screen.getByLabelText("Auth")).not.toHaveTextContent("ghp_s3cr3t")
      const resolveRequests = invoke.mock.calls.filter(([c]) => c === "boilerplate:resolve-inputs")
      expect(resolveRequests.length).toBeGreaterThan(0)
      for (const [, request] of resolveRequests) {
        expect(request.inputs).not.toHaveProperty("token")
      }
    })
  })

  describe("outputs", () => {
    beforeEach(() => {
      mockConfigReturn = {
        ...mockConfigReturn,
        data: {
          variables: [],
          outputDependencies: [
            { blockId: "mint", outputName: "token", fullPath: "outputs.mint.token" },
          ],
        },
      }
    })

    function renderedTokens() {
      return renderMock.render.mock.calls.map(
        ([vars]) =>
          (vars as { outputs: Record<string, Record<string, unknown>> }).outputs.mint?.token,
      )
    }

    function renderAndGenerate() {
      const utils = renderTemplate()
      act(() => ctx.registerOutputs("mint", { token: sensitiveOutput("first-token") }))
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      // A Template writes files, so it renders a sensitive output's real value.
      expect(renderedTokens()).toEqual(["first-token"])
      renderMock.render.mockClear()
      succeedRender(utils.rerender, testTemplate())
      return utils
    }

    // The change key has to see a sensitive output's real value, or a new
    // token would never mark the files stale.
    it("goes stale when a sensitive output it reads changes, and Regenerate renders the new value", () => {
      const { container } = renderAndGenerate()

      act(() => ctx.registerOutputs("mint", { token: sensitiveOutput("second-token") }))
      expect(renderedTokens()).toEqual([])
      expect(formBlock(container).className).toContain("bg-warning-muted")

      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))
      expect(renderedTokens()).toEqual(["second-token"])
    })

    it("stays up to date when a block it does not read produces an output", () => {
      const { container } = renderAndGenerate()

      act(() => ctx.registerOutputs("unrelated", { value: "anything" }))

      expect(formBlock(container).className).toContain("bg-success-muted")
      expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull()
    })
  })

  describe("editing after generating", () => {
    function renderAndGenerate() {
      const utils = renderTemplate()
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      renderMock.render.mockClear()
      succeedRender(utils.rerender, testTemplate())
      return utils
    }

    function typeRegion(value: string) {
      fireEvent.change(screen.getByLabelText(/Region/), { target: { value } })
    }

    it("turns yellow and waits for Regenerate, without rendering", () => {
      const { container } = renderAndGenerate()
      expect(formBlock(container).className).toContain("bg-success-muted")

      typeRegion("eu-west-1")

      expect(renderMock.render).not.toHaveBeenCalled()
      expect(formBlock(container).className).toContain("bg-warning-muted")
      expect(formBlock(container).className).not.toContain("bg-success-muted")
      expect(screen.queryByText("Up to date")).toBeNull()

      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))

      expect(renderedRegions()).toEqual(["eu-west-1"])
      expect(formBlock(container).className).toContain("bg-success-muted")
      expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull()
    })

    it("returns to up to date when the edit is undone", () => {
      const { container } = renderAndGenerate()

      typeRegion("eu-west-1")
      expect(formBlock(container).className).toContain("bg-warning-muted")

      typeRegion("us-east-1")
      expect(formBlock(container).className).toContain("bg-success-muted")
      expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull()
      expect(renderMock.render).not.toHaveBeenCalled()
    })
  })

  describe("generate outcome", () => {
    it("keeps the Generate button after a failed first render, and a retry renders again", () => {
      const { container, rerender } = renderTemplate()
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(renderMock.render).toHaveBeenCalledTimes(1)

      renderMock.error = { message: "template error" }
      rerender(testTemplate())

      expect(screen.getByText(/template error/)).toBeInTheDocument()
      expect(formBlock(container).className).not.toContain("bg-success-muted")
      expect(screen.queryByText("Up to date")).toBeNull()

      // Same values as the failed render: the retry must still dispatch.
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(renderMock.render).toHaveBeenCalledTimes(2)
    })

    it("turns green only after a render succeeds, and offers a retry when a later render fails", () => {
      const { container, rerender } = renderTemplate()

      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
      expect(formBlock(container).className).not.toContain("bg-success-muted")

      succeedRender(rerender, testTemplate())
      expect(formBlock(container).className).toContain("bg-success-muted")
      expect(screen.getByText("Up to date")).toBeInTheDocument()

      renderMock.error = { message: "template error" }
      rerender(testTemplate())
      expect(formBlock(container).className).not.toContain("bg-success-muted")
      expect(screen.queryByText("Up to date")).toBeNull()
      expect(screen.getByText(/Generation failed/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))
      expect(renderMock.render).toHaveBeenCalledTimes(2)
    })
  })
})
