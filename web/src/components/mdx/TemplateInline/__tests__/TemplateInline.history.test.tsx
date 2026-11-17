import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type TestApi } from "@/test/test-api"
import { renderedInline } from "@/test/render-inline"
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

/** Renders each template file with `.inputs.name`, answering the way main does. */
function makeTestApiRenderingInline() {
  return makeTestApi({
    "boilerplate:render-inline": (params) => {
      const inputs = params.inputs.find((input) => input.name === "inputs")?.value
      const name =
        typeof inputs === "object" && inputs !== null && "name" in inputs ? inputs.name : undefined
      const contents = Object.fromEntries(
        Object.entries(params.templateFiles).map(([file, content]) => [
          file,
          content.replace("{{ .inputs.name }}", String(name)),
        ]),
      )
      return params.generateFile
        ? renderedInline(contents, {
            fileTree: [],
            totalFiles: 1,
            truncatedTree: false,
            heavyDirs: [],
          })
        : renderedInline(contents)
    },
    "session:record-event": () => ({ ok: true }),
    "native:set-theme": () => ({ ok: true }),
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

let testApi: TestApi
/** How many of each channel's calls were made before the last forgetCalls(). */
let forgotten = { renders: 0, events: 0 }

/** Each render-inline request, oldest first. */
const renderCalls = () => testApi.callsTo("boilerplate:render-inline").slice(forgotten.renders)

/** The payload of each `render` event sent to the main process, oldest first. */
const recordedRenders = () =>
  testApi
    .callsTo("session:record-event")
    .slice(forgotten.events)
    .filter((event) => event.kind === "render")
    .map((event) => {
      expect(event.blockId).toBe("tpl")
      return event.payload
    })

/** Forgets the calls made so far: renderCalls() and recordedRenders() list only later ones. */
const forgetCalls = () => {
  forgotten = {
    renders: testApi.callsTo("boilerplate:render-inline").length,
    events: testApi.callsTo("session:record-event").length,
  }
}

/**
 * The block in a session whose history says it last wrote what `written`
 * hashes to, with the inputs block registering `values`.
 */
function renderBlock({
  values,
  written,
  generateFile = true,
  target,
}: {
  values: Record<string, unknown>
  written?: unknown
  generateFile?: boolean
  target?: "generated"
}) {
  const blockStates: SavedBlockState[] =
    written === undefined ? [] : [{ blockId: "tpl", kind: "render", payload: written }]
  const ui = (current: Record<string, unknown>) => (
    <ApiProvider api={testApi.api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          <RegisterInputs values={current} />
          <TemplateInline
            id="tpl"
            inputsId="form"
            outputPath="out.txt"
            generateFile={generateFile}
            target={target}
          >
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
  forgetCalls()
  applyFileTreeUpdate.mockClear()
  return written
}

describe("TemplateInline in a session", () => {
  beforeEach(() => {
    testApi = makeTestApiRenderingInline()
    forgotten = { renders: 0, events: 0 }
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

  it("writes the file when it was last written for another target", async () => {
    const written = await writeOnce({ name: "world" })

    renderBlock({ values: { name: "world" }, written, target: "generated" })
    await settle()

    expect(renderCalls()).toHaveLength(1)
    expect(renderCalls()[0]?.generateFile).toBe(true)
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
