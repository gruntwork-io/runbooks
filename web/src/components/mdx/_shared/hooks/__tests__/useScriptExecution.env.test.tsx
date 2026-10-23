import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import {
  ExecutableRegistryContext,
  type ExecutableRegistryContextValue,
} from "@/contexts/ExecutableRegistryContext.types"
import { GeneratedFilesProvider } from "@/contexts/GeneratedFilesContext"
import { IpcGitWorkTreeProvider } from "@/contexts/IpcGitWorkTreeContext"
import { LogsProvider } from "@/contexts/LogsContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { TestWrapper } from "@/test/test-utils"
import { makeConfig } from "@/test/make-config"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { Executable } from "@/types/executable"
import { useScriptExecution } from "../useScriptExecution"

// `boilerplate:render-inline` calls stay pending until the test settles them.
interface PendingRender {
  templateFiles: Record<string, string>
  resolve: (value: unknown) => void
}

const renders: PendingRender[] = []
const invoke = vi.fn((channel: string, params?: { templateFiles: Record<string, string> }) => {
  if (channel === "boilerplate:render-inline") {
    return new Promise((resolve) => {
      renders.push({ templateFiles: params!.templateFiles, resolve })
    })
  }
  return Promise.resolve({ ok: true })
})
const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI

let registered: Executable | null = null
const registry: ExecutableRegistryContextValue = {
  getExecutableByComponentId: () => registered,
  registryVersion: 0,
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ApiProvider api={api}>
      <TestWrapper>
        <ExecutableRegistryContext.Provider value={registry}>
          <GeneratedFilesProvider>
            <IpcGitWorkTreeProvider>
              <LogsProvider>{children}</LogsProvider>
            </IpcGitWorkTreeProvider>
          </GeneratedFilesProvider>
        </ExecutableRegistryContext.Provider>
      </TestWrapper>
    </ApiProvider>
  )
}

const config = makeConfig([{ name: "BucketName", type: BoilerplateVariableType.String }])
const COMMAND = 'aws s3 mb "s3://$BUCKET"'

function renderCommand(env: unknown) {
  return renderHook(
    () => ({
      exec: useScriptExecution({
        componentId: "make-bucket",
        command: COMMAND,
        inputsId: "form",
        componentType: "command",
        env,
      }),
      runbook: useRunbookContext(),
    }),
    { wrapper: Providers },
  )
}

beforeEach(() => {
  renders.length = 0
  invoke.mockClear()
  registered = null
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useScriptExecution — env prop", () => {
  it("waits for the inputs its env references, then shows the env rendered with the script", async () => {
    const { result } = renderCommand({ BUCKET: "{{ .inputs.BucketName }}", COUNT: 2 })

    expect(result.current.exec.inputDependencies).toEqual(["BucketName"])
    expect(result.current.exec.hasAllInputDependencies).toBe(false)
    expect(result.current.exec.envVars).toEqual([
      { name: "BUCKET", value: "{{ .inputs.BucketName }}" },
      { name: "COUNT", value: "2" },
    ])

    await act(async () => {
      result.current.runbook.registerInputs("form", { BucketName: "my-bucket" }, config)
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    // One render for the script and the env values that are templates
    expect(renders).toHaveLength(1)
    expect(renders[0]!.templateFiles).toEqual({
      "script.sh": COMMAND,
      "env:BUCKET": "{{ .inputs.BucketName }}",
    })

    await act(async () => {
      renders[0]!.resolve({
        renderedFiles: {
          "script.sh": { content: COMMAND },
          "env:BUCKET": { content: "my-bucket" },
        },
      })
    })
    expect(result.current.exec.envVars).toEqual([
      { name: "BUCKET", value: "my-bucket" },
      { name: "COUNT", value: "2" },
    ])
    expect(result.current.exec.envError).toBeNull()
  })

  it("says why an env prop isn't valid, and uses none of it", () => {
    const { result } = renderCommand({ "MY-VAR": "{{ .inputs.BucketName }}" })

    expect(result.current.exec.envError).toBe(
      '"MY-VAR" in env is not a variable name. Use letters, digits and underscores, and don\'t start with a digit.',
    )
    expect(result.current.exec.envTemplates).toEqual({})
    expect(result.current.exec.inputDependencies).toEqual([])
  })

  it("flags drift when the env Run will set isn't the env the block shows", () => {
    const entry: Executable = {
      id: "e1",
      type: "inline",
      componentId: "make-bucket",
      componentType: "command",
      contentHash: "hash-of-the-command",
      env: { BUCKET: "{{ .inputs.BucketName }}" },
    }

    registered = entry
    expect(
      renderCommand({ BUCKET: "{{ .inputs.BucketName }}" }).result.current.exec.hasScriptDrift,
    ).toBe(false)

    registered = { ...entry, env: { BUCKET: "{{ .inputs.OldName }}" } }
    expect(
      renderCommand({ BUCKET: "{{ .inputs.BucketName }}" }).result.current.exec.hasScriptDrift,
    ).toBe(true)
  })
})
