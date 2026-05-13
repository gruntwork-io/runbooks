import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

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

vi.mock("@/hooks/useApiBoilerplateRender", () => ({
  useApiBoilerplateRender: () => ({
    render: vi.fn(),
    isRendering: false,
    renderResult: null,
    renderError: null,
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
})
