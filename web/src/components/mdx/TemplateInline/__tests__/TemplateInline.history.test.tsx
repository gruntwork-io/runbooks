import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import { ApiProvider } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// A TemplateInline block under the real session history provider. The mock
// boundary is the preload API: boilerplate:render-inline answers the way main
// does, and session:record-event is where the block's history leaves the
// renderer.

vi.mock("@/components/artifacts/code/CodeFile", () => ({
  CodeFile: ({ filePath, code }: { filePath: string; code: string }) => (
    <div data-testid={`code-file-${filePath}`}>{code}</div>
  ),
}))

const { applyFileTreeUpdate } = vi.hoisted(() => ({ applyFileTreeUpdate: vi.fn() }))
vi.mock("../../_shared/hooks/useFileTreeUpdater", () => ({
  useFileTreeUpdater: () => ({ applyFileTreeUpdate }),
}))

import TemplateInline from "../TemplateInline"

const TEMPLATE = "Hello {{ .inputs.name }}"
const DEBOUNCE_SETTLE_MS = 450

interface RenderInlineParams {
  templateFiles: Record<string, string>
  inputs: Array<{ name: string; value: unknown }>
  generateFile?: boolean
}

function makeInvoke() {
  return vi.fn((channel: string, params?: RenderInlineParams) => {
    if (channel !== "boilerplate:render-inline" || !params) {
      return Promise.resolve({ ok: true })
    }
    const inputs = (params.inputs.find((i) => i.name === "inputs")?.value ?? {}) as Record<
      string,
      unknown
    >
    const renderedFiles = Object.fromEntries(
      Object.entries(params.templateFiles).map(([name, content]) => [
        name,
        {
          name,
          path: name,
          content: content.replace("{{ .inputs.name }}", String(inputs.name)),
          language: "",
        },
      ]),
    )
    return Promise.resolve(
      params.generateFile
        ? { renderedFiles, fileTree: [], totalFiles: 1, truncatedTree: false, heavyDirs: [] }
        : { renderedFiles },
    )
  })
}

function RegisterInputs({ values }: { values: Record<string, unknown> }) {
  const { registerInputs } = useRunbookContext()
  useEffect(() => {
    registerInputs("form", values, {
      variables: [{ name: "name", description: "", type: BoilerplateVariableType.String }],
    })
  }, [registerInputs, values])
  return null
}

let invoke: ReturnType<typeof makeInvoke>

/** Each render-inline request, oldest first. */
const renderCalls = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === "boilerplate:render-inline")
    .map(([, params]) => params as RenderInlineParams)

/** The payload of each `render` event sent to the main process, oldest first. */
const recordedRenders = () =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { blockId: string; kind: string; payload: unknown }])
    .filter(([channel, event]) => channel === "session:record-event" && event.kind === "render")
    .map(([, event]) => {
      expect(event.blockId).toBe("tpl")
      return event.payload
    })

/**
 * The block in a session whose history says it last wrote what `written`
 * hashes to, with the inputs block registering `values`.
 */
function renderBlock({
  values,
  written,
  generateFile = true,
}: {
  values: Record<string, unknown>
  written?: unknown
  generateFile?: boolean
}) {
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]["api"]
  const blockStates: SavedBlockState[] =
    written === undefined ? [] : [{ blockId: "tpl", kind: "render", payload: written }]
  const ui = (current: Record<string, unknown>) => (
    <ApiProvider api={api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          <RegisterInputs values={current} />
          <TemplateInline id="tpl" inputsId="form" outputPath="out.txt" generateFile={generateFile}>
            <pre>
              <code className="language-txt">{TEMPLATE}</code>
            </pre>
          </TemplateInline>
        </TestWrapper>
      </IpcSessionHistoryProvider>
    </ApiProvider>
  )
  const utils = render(ui(values))
  return { ...utils, rerender: (next: Record<string, unknown>) => utils.rerender(ui(next)) }
}

/** Wait out the 300ms render debounce and the hash. */
const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, DEBOUNCE_SETTLE_MS)
      }),
  )

/** Write the file once with `values`, and return the render event that recorded it. */
async function writeOnce(values: Record<string, unknown>): Promise<unknown> {
  const { unmount } = renderBlock({ values })
  await settle()
  expect(renderCalls().at(-1)?.generateFile).toBe(true)
  const written = recordedRenders().at(-1)
  unmount()
  invoke.mockClear()
  applyFileTreeUpdate.mockClear()
  return written
}

describe("TemplateInline in a session", () => {
  beforeEach(() => {
    invoke = makeInvoke()
    applyFileTreeUpdate.mockClear()
  })

  it("records a hash of what it wrote", async () => {
    renderBlock({ values: { name: "world" } })
    await settle()

    expect(renderCalls()).toHaveLength(1)
    expect(renderCalls()[0]?.generateFile).toBe(true)
    expect(recordedRenders()).toEqual([{ writtenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }])
  })

  it("shows the file without writing it when it would come out as it was written", async () => {
    const written = await writeOnce({ name: "world" })

    renderBlock({ values: { name: "world" }, written })
    await settle()

    expect(renderCalls()).toHaveLength(1)
    expect(renderCalls()[0]?.generateFile).toBe(false)
    expect(await screen.findByTestId("code-file-out.txt")).toHaveTextContent("Hello world")
    expect(applyFileTreeUpdate).not.toHaveBeenCalled()
    expect(recordedRenders()).toEqual([])
  })

  it("writes the file when it would come out differently than it was written", async () => {
    const written = await writeOnce({ name: "world" })

    renderBlock({ values: { name: "there" }, written })
    await settle()

    expect(renderCalls()).toHaveLength(1)
    expect(renderCalls()[0]?.generateFile).toBe(true)
    expect(recordedRenders()).toHaveLength(1)
    expect(recordedRenders()[0]).not.toEqual(written)
  })

  it("writes on the first change after showing the file it was resumed with", async () => {
    const written = await writeOnce({ name: "world" })
    const { rerender } = renderBlock({ values: { name: "world" }, written })
    await settle()
    expect(renderCalls().at(-1)?.generateFile).toBe(false)

    rerender({ name: "there" })
    await settle()

    expect(renderCalls().at(-1)?.generateFile).toBe(true)
    expect(recordedRenders()).toHaveLength(1)
  })

  it("records nothing when it only previews", async () => {
    renderBlock({ values: { name: "world" }, generateFile: false })
    await settle()

    expect(renderCalls()[0]?.generateFile).toBe(false)
    expect(recordedRenders()).toEqual([])
  })
})
