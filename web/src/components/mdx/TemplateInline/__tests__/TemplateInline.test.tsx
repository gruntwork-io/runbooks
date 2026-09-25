import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { useEffect } from "react"
import { ApiProvider } from "@/contexts/ApiContext"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { INSTRUCTION_MODE_STORAGE_KEY } from "@/contexts/InstructionModeContext.types"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"

// =============================================================================
// TemplateInline render/generate tests
// =============================================================================
//
// Mock boundary: the IPC API (window.api via ApiProvider). The component's
// gating, debounce, dedupe and response handling run as real code.

// Stub the syntax-highlighted code view; tests read the rendered content.
vi.mock("@/components/artifacts/code/CodeFile", () => ({
  CodeFile: ({ filePath, code }: { filePath: string; code: string }) => (
    <div data-testid={`code-file-${filePath}`}>{code}</div>
  ),
}))

// The real hook needs the GeneratedFiles and GitWorkTree providers. Keep its
// shape so tests can assert when the Generated tree would be replaced.
const { applyFileTreeUpdate } = vi.hoisted(() => ({ applyFileTreeUpdate: vi.fn() }))
vi.mock("../../_shared/hooks/useFileTreeUpdater", () => ({
  useFileTreeUpdater: () => ({ applyFileTreeUpdate }),
}))

import TemplateInline from "../TemplateInline"

const TEMPLATE = "Hello {{ .inputs.name }}"
const DEBOUNCE_SETTLE_MS = 450

const GENERATED_TREE = [{ id: "out.txt", name: "out.txt", type: "file", children: [] }]

interface RenderInlineParams {
  templateFiles: Record<string, string>
  inputs: Array<{ name: string; value: unknown }>
  generateFile?: boolean
  target?: string
}

/**
 * An invoke that answers boilerplate:render-inline the way main does: the
 * rendered files always, and a fileTree (plus truncation fields) only when the
 * request asked it to write files.
 */
function makeInvoke() {
  return vi.fn((channel: string, params?: RenderInlineParams) => {
    if (channel !== "boilerplate:render-inline" || !params) {
      return Promise.resolve({ ok: true })
    }
    const inputs = (params.inputs.find((i) => i.name === "inputs")?.value ?? {}) as Record<string, unknown>
    const renderedFiles = Object.fromEntries(
      Object.entries(params.templateFiles).map(([name, content]) => [
        name,
        { name, path: name, content: content.replace("{{ .inputs.name }}", String(inputs.name)), language: "" },
      ]),
    )
    return Promise.resolve(
      params.generateFile
        ? { renderedFiles, fileTree: GENERATED_TREE, totalFiles: 1, truncatedTree: false, heavyDirs: [] }
        : { renderedFiles },
    )
  })
}

function renderInlineCalls(invoke: ReturnType<typeof makeInvoke>) {
  return invoke.mock.calls
    .filter((c) => c[0] === "boilerplate:render-inline")
    .map((c) => c[1] as RenderInlineParams)
}

/** Registers values for an Inputs block, as <Inputs> does. */
function RegisterInputs({ values }: { values: Record<string, unknown> }) {
  const { registerInputs } = useRunbookContext()
  useEffect(() => {
    registerInputs("form", values, {
      variables: [
        { name: "name", description: "", type: BoilerplateVariableType.String },
        { name: "count", description: "", type: BoilerplateVariableType.Int },
      ],
    })
  }, [registerInputs, values])
  return null
}

function InstructionModeToggle() {
  const { enabled, setEnabled } = useInstructionMode()
  return <button onClick={() => setEnabled(!enabled)}>toggle instruction mode</button>
}

type BlockProps = {
  generateFile?: boolean
  target?: "generated" | "worktree"
  values?: Record<string, unknown>
}

function renderBlock(initial: BlockProps = {}) {
  const invoke = makeInvoke()
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<typeof ApiProvider>[0]["api"]
  const ui = ({ generateFile, target, values }: BlockProps) => (
    <ApiProvider api={api}>
      <TestWrapper>
        <InstructionModeToggle />
        {values && <RegisterInputs values={values} />}
        <TemplateInline id="tpl" inputsId="form" outputPath="out.txt" generateFile={generateFile} target={target}>
          <pre><code className="language-txt">{TEMPLATE}</code></pre>
        </TemplateInline>
      </TestWrapper>
    </ApiProvider>
  )
  const utils = render(ui(initial))
  return { invoke, rerender: (next: BlockProps) => utils.rerender(ui(next)) }
}

/** Wait out the 300ms render debounce, so "no call" assertions mean something. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_SETTLE_MS)))

const WORLD = { name: "world", count: 3 }

describe("TemplateInline", () => {
  beforeEach(() => {
    applyFileTreeUpdate.mockClear()
    localStorage.removeItem(INSTRUCTION_MODE_STORAGE_KEY)
  })

  afterEach(() => {
    localStorage.removeItem(INSTRUCTION_MODE_STORAGE_KEY)
  })

  it("shows an error for a missing id", () => {
    render(
      <TestWrapper>
        <TemplateInline id="" outputPath="out.txt">
          <pre><code className="language-txt">template</code></pre>
        </TemplateInline>
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("waits for its inputs block, then renders once with the inputs payload", async () => {
    const { invoke, rerender } = renderBlock()

    expect(screen.getByText("Waiting for inputs from:")).toBeInTheDocument()
    await settle()
    expect(renderInlineCalls(invoke)).toHaveLength(0)

    rerender({ values: WORLD })

    await waitFor(() => expect(screen.getByTestId("code-file-out.txt")).toHaveTextContent("Hello world"))
    expect(screen.queryByText("Waiting for inputs from:")).not.toBeInTheDocument()
    const calls = renderInlineCalls(invoke)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      templateFiles: { "out.txt": TEMPLATE },
      inputs: [
        { name: "inputs", type: BoilerplateVariableType.Map, value: { name: "world", count: 3 } },
        { name: "outputs", type: BoilerplateVariableType.Map, value: {} },
      ],
      generateFile: false,
    })
  })

  it("does not render again when nothing it depends on changed", async () => {
    const { invoke, rerender } = renderBlock({ values: WORLD })
    await waitFor(() => expect(renderInlineCalls(invoke)).toHaveLength(1))

    // New children elements and props objects, same content.
    rerender({ values: { ...WORLD } })
    await settle()

    expect(renderInlineCalls(invoke)).toHaveLength(1)
  })

  it("renders again when an input changes", async () => {
    const { invoke, rerender } = renderBlock({ values: WORLD })
    await waitFor(() => expect(renderInlineCalls(invoke)).toHaveLength(1))

    rerender({ values: { ...WORLD, name: "there" } })

    await waitFor(() => expect(screen.getByTestId("code-file-out.txt")).toHaveTextContent("Hello there"))
    expect(renderInlineCalls(invoke)).toHaveLength(2)
  })

  it("skips rendering while a numeric input is empty", async () => {
    const { invoke } = renderBlock({ values: { name: "world", count: "" } })
    await settle()

    expect(renderInlineCalls(invoke)).toHaveLength(0)
  })

  it("preview only: never touches the Generated tree", async () => {
    const { invoke } = renderBlock({ values: WORLD })

    await waitFor(() => expect(screen.getByTestId("code-file-out.txt")).toBeInTheDocument())
    expect(renderInlineCalls(invoke)[0].generateFile).toBe(false)
    expect(applyFileTreeUpdate).not.toHaveBeenCalled()
  })

  it("generateFile: asks main to write and applies the tree it returns", async () => {
    const { invoke } = renderBlock({ values: WORLD, generateFile: true })

    await waitFor(() => expect(applyFileTreeUpdate).toHaveBeenCalledTimes(1))
    const call = renderInlineCalls(invoke)[0]
    expect(call.generateFile).toBe(true)
    expect(call).not.toHaveProperty("target")
    expect(applyFileTreeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ fileTree: GENERATED_TREE, totalFiles: 1, truncatedTree: false }),
    )
  })

  it("generateFile with target=worktree sends the target", async () => {
    const { invoke } = renderBlock({ values: WORLD, generateFile: true, target: "worktree" })

    await waitFor(() => expect(renderInlineCalls(invoke)).toHaveLength(1))
    expect(renderInlineCalls(invoke)[0]).toMatchObject({ generateFile: true, target: "worktree" })
  })

  it("instruction mode forces generateFile off and leaves the Generated tree alone", async () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, "true")
    const { invoke } = renderBlock({ values: WORLD, generateFile: true })

    await waitFor(() => expect(screen.getByTestId("code-file-out.txt")).toHaveTextContent("Hello world"))
    await settle()
    expect(renderInlineCalls(invoke)).toHaveLength(1)
    expect(renderInlineCalls(invoke)[0].generateFile).toBe(false)
    expect(applyFileTreeUpdate).not.toHaveBeenCalled()
  })

  it("leaving instruction mode renders again to write the file, without applying the preview response", async () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, "true")
    const { invoke } = renderBlock({ values: WORLD, generateFile: true, target: "worktree" })
    await waitFor(() => expect(screen.getByTestId("code-file-out.txt")).toBeInTheDocument())
    expect(renderInlineCalls(invoke)).toHaveLength(1)

    fireEvent.click(screen.getByText("toggle instruction mode"))

    await waitFor(() => expect(renderInlineCalls(invoke)).toHaveLength(2))
    expect(renderInlineCalls(invoke)[1]).toMatchObject({ generateFile: true, target: "worktree" })
    await waitFor(() => expect(applyFileTreeUpdate).toHaveBeenCalled())
    // Only the response that wrote files reaches the updater; the preview
    // response still held in state when the mode flipped does not.
    expect(applyFileTreeUpdate).toHaveBeenCalledTimes(1)
    expect(applyFileTreeUpdate.mock.calls[0][0]).toMatchObject({ fileTree: GENERATED_TREE })
  })
})
