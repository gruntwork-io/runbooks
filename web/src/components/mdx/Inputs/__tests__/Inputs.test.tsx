import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import Inputs from "../Inputs"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"

// ---------------------------------------------------------------------------
// Mock useApiGetBoilerplateConfig — controls config loading
// ---------------------------------------------------------------------------

const defaultConfig: BoilerplateConfig = {
  variables: [
    { name: "region", type: "string", description: "AWS region", default: "us-east-1" },
    { name: "count", type: "int", description: "Instance count", default: 3 },
    { name: "enable_logging", type: "bool", description: "Enable logging", default: true },
    { name: "env", type: "enum", description: "Environment", options: ["dev", "staging", "prod"], default: "dev" },
  ],
  outputDependencies: [],
}

let mockApiReturn = {
  data: defaultConfig as BoilerplateConfig | null,
  isLoading: false,
  error: null as { message: string; details?: string } | null,
  refetch: vi.fn(),
  silentRefetch: vi.fn(),
}

vi.mock("@/hooks/useApiGetBoilerplateConfig", () => ({
  useApiGetBoilerplateConfig: () => mockApiReturn,
}))

// Mock useLogs since it's used indirectly
vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderInputs(props: Partial<React.ComponentProps<typeof Inputs>> = {}) {
  return render(
    <TestWrapper>
      <Inputs id="test-inputs" path="boilerplate.yml" {...props} />
    </TestWrapper>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Inputs", () => {
  beforeEach(() => {
    mockApiReturn = {
      data: defaultConfig,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      silentRefetch: vi.fn(),
    }
  })

  // --- Rendering ---

  it("renders with valid props", () => {
    renderInputs()
    expect(screen.getByTestId("test-inputs")).toBeInTheDocument()
  })

  it("renders form fields for each variable", () => {
    renderInputs()
    expect(screen.getByText("AWS region")).toBeInTheDocument()
    expect(screen.getByText("Instance count")).toBeInTheDocument()
    expect(screen.getByText("Enable logging")).toBeInTheDocument()
    expect(screen.getByText("Environment")).toBeInTheDocument()
  })

  it("renders field for each variable with data-testid", () => {
    renderInputs()
    expect(screen.getByTestId("field-region")).toBeInTheDocument()
    expect(screen.getByTestId("field-count")).toBeInTheDocument()
    expect(screen.getByTestId("field-enable_logging")).toBeInTheDocument()
    expect(screen.getByTestId("field-env")).toBeInTheDocument()
  })

  // --- Loading state ---

  it("shows loading state while config is fetching", () => {
    mockApiReturn = { ...mockApiReturn, data: null, isLoading: true }
    renderInputs()
    expect(screen.getByText("Loading configuration...")).toBeInTheDocument()
  })

  // --- Validation errors ---

  it("shows error when id is empty", () => {
    render(
      <TestWrapper>
        <Inputs id="" path="boilerplate.yml" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("shows error when neither path nor children are provided", () => {
    render(
      <TestWrapper>
        <Inputs id="test" />
      </TestWrapper>,
    )
    expect(screen.getByText(/Invalid <Inputs> configuration/)).toBeInTheDocument()
  })

  it("shows error when both path and children are provided", () => {
    render(
      <TestWrapper>
        <Inputs id="test" path="boilerplate.yml">
          <pre><code className="language-yaml">{"variables:\n  - name: test\n    type: string"}</code></pre>
        </Inputs>
      </TestWrapper>,
    )
    expect(screen.getByText(/cannot specify both/i)).toBeInTheDocument()
  })

  // --- API error ---

  it("shows error when config loading fails", () => {
    mockApiReturn = {
      ...mockApiReturn,
      data: null,
      error: { message: "Failed to load boilerplate config" },
    }
    renderInputs()
    expect(screen.getByText(/Failed to load boilerplate config/)).toBeInTheDocument()
  })

  // --- Variable types ---

  it("renders string field with default value", () => {
    renderInputs()
    const regionField = screen.getByTestId("field-region")
    const input = regionField.querySelector("input")
    expect(input).toHaveValue("us-east-1")
  })

  it("renders int field with default value", () => {
    renderInputs()
    const countField = screen.getByTestId("field-count")
    const input = countField.querySelector("input")
    expect(input).toHaveValue(3)
  })

  it("renders sensitive field as password type", () => {
    mockApiReturn = {
      ...mockApiReturn,
      data: {
        variables: [
          { name: "password", type: "string", description: "Secret", default: "s3cret", sensitive: true },
        ],
        outputDependencies: [],
      },
    }
    renderInputs()
    const field = screen.getByTestId("field-password")
    const input = field.querySelector("input")
    expect(input).toHaveAttribute("type", "password")
  })

  it("renders list variable", () => {
    mockApiReturn = {
      ...mockApiReturn,
      data: {
        variables: [
          { name: "tags", type: "list", description: "Resource tags" },
        ],
        outputDependencies: [],
      },
    }
    renderInputs()
    expect(screen.getByText("Resource tags")).toBeInTheDocument()
  })

  it("renders map variable", () => {
    mockApiReturn = {
      ...mockApiReturn,
      data: {
        variables: [
          { name: "labels", type: "map", description: "Key-value labels" },
        ],
        outputDependencies: [],
      },
    }
    renderInputs()
    expect(screen.getByText("Key-value labels")).toBeInTheDocument()
  })

  // --- Prefilled variables ---

  it("applies prefilled variables to defaults", () => {
    renderInputs({ prefilledVariables: { region: "eu-west-1" } })
    const regionField = screen.getByTestId("field-region")
    const input = regionField.querySelector("input")
    expect(input).toHaveValue("eu-west-1")
  })
})
