import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

// Mock useApi for render-inline IPC calls
vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    data: null,
    isLoading: false,
    error: null,
    debouncedRequest: vi.fn(),
    refetch: vi.fn(),
    silentRefetch: vi.fn(),
  }),
}))

// Mock CodeFile to avoid syntax highlighter dependency
vi.mock("@/components/artifacts/code/CodeFile", () => ({
  CodeFile: ({ displayPath }: { displayPath: string }) => <div data-testid={`code-file-${displayPath}`}>Code: {displayPath}</div>,
}))

// Mock useGeneratedFiles (requires GeneratedFilesProvider context)
vi.mock("@/hooks/useGeneratedFiles", () => ({
  useGeneratedFiles: () => ({
    updateFileTree: vi.fn(),
  }),
}))

// Mock the file tree updater hook used by TemplateInline
vi.mock("../../_shared/hooks/useFileTreeUpdater", () => ({
  useFileTreeUpdater: () => vi.fn(),
}))

import TemplateInline from "../TemplateInline"

function renderTemplateInline(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <TemplateInline id="test-tpl-inline" outputPath="output.txt" {...props}>
        <pre><code className="language-txt">{"Hello {{ .inputs.name }}"}</code></pre>
      </TemplateInline>
    </TestWrapper>,
  )
}

describe("TemplateInline", () => {
  it("renders with valid props", () => {
    renderTemplateInline()
    expect(screen.getByTestId("test-tpl-inline")).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <TemplateInline id="" outputPath="out.txt">
          <pre><code className="language-txt">template</code></pre>
        </TemplateInline>
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("renders without crashing with valid template content", () => {
    renderTemplateInline()
    // Should render the block without errors
    const block = screen.getByTestId("test-tpl-inline")
    expect(block).toBeInTheDocument()
  })
})
