import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { ApiProvider } from "@/contexts/ApiContext"
import {
  ExecutableRegistryContext,
  type ExecutableRegistryContextValue,
} from "@/contexts/ExecutableRegistryContext.types"
import { GeneratedFilesProvider } from "@/contexts/GeneratedFilesContext"
import { IpcGitWorkTreeProvider } from "@/contexts/IpcGitWorkTreeContext"
import { LogsProvider } from "@/contexts/LogsContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { TestWrapper } from "@/test/test-utils"
import { makeTestApi, type HeldCall, type TestApi } from "@/test/test-api"
import { makeConfig } from "@/test/make-config"
import { renderedInline } from "@/test/render-inline"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import { useScriptExecution } from "../useScriptExecution"

let testApi: TestApi
// `boilerplate:render-inline` calls stay pending until the test settles them,
// so the test decides the order in which renders land.
let renders: readonly HeldCall<"boilerplate:render-inline">[]

const registry: ExecutableRegistryContextValue = {
  getExecutableByComponentId: () => null,
  registryVersion: 0,
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ApiProvider api={testApi.api}>
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

const config = makeConfig([{ name: "name", type: BoilerplateVariableType.String }])
const rendered = (value: string) => renderedInline({ "env:NAME": value })

function renderCommand(env: Record<string, string> = { NAME: "{{ .inputs.name }}" }) {
  return renderHook(
    (props: { env: Record<string, string> }) => ({
      exec: useScriptExecution({
        componentId: "greet",
        command: 'echo "$NAME"',
        env: props.env,
        inputsId: "form",
        componentType: "command",
      }),
      runbook: useRunbookContext(),
    }),
    { wrapper: Providers, initialProps: { env } },
  )
}

/** The value the block shows for its NAME env var. */
const shownName = (result: ReturnType<typeof renderCommand>["result"]) =>
  result.current.exec.envVars.find((envVar) => envVar.name === "NAME")?.value

/** Type a value into the form and let the 300ms render debounce fire. */
async function typeName(result: ReturnType<typeof renderCommand>["result"], name: string) {
  await act(async () => {
    result.current.runbook.registerInputs("form", { name }, config)
  })
  await act(async () => {
    vi.advanceTimersByTime(300)
  })
}

beforeEach(() => {
  testApi = makeTestApi({ "native:set-theme": () => ({ ok: true }) })
  renders = testApi.hold("boilerplate:render-inline")
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useScriptExecution render ordering", () => {
  it("shows the latest render when an earlier one lands after it", async () => {
    const { result } = renderCommand()

    await typeName(result, "first")
    await typeName(result, "second")
    expect(renders).toHaveLength(2)

    await act(async () => {
      renders[1]!.resolve(rendered("second"))
    })
    await act(async () => {
      renders[0]!.resolve(rendered("first"))
    })
    expect(shownName(result)).toBe("second")
    expect(result.current.exec.isRendering).toBe(false)
  })

  it("ignores a failure from a render that was already superseded", async () => {
    const { result } = renderCommand()

    await typeName(result, "first")
    await typeName(result, "second")

    await act(async () => {
      renders[1]!.resolve(rendered("second"))
    })
    await act(async () => {
      renders[0]!.reject(new Error("template: missing value for name"))
    })
    expect(result.current.exec.renderError).toBeNull()
    expect(shownName(result)).toBe("second")
  })

  it("keeps the raw template when an output goes missing while its render is in flight", async () => {
    const { result } = renderCommand({ NAME: "{{ .outputs.build.version }}" })

    await act(async () => {
      result.current.runbook.registerOutputs("build", { version: "1.2.3" })
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(renders).toHaveLength(1)
    expect(result.current.exec.isRendering).toBe(true)

    // A re-run of the build block failed without outputs
    await act(async () => {
      result.current.runbook.registerOutputs("build", {})
    })
    expect(result.current.exec.isRendering).toBe(false)

    await act(async () => {
      renders[0]!.resolve(rendered("1.2.3"))
    })
    expect(shownName(result)).toBe("{{ .outputs.build.version }}")
    expect(result.current.exec.isRendering).toBe(false)
  })

  it("keeps an env that lost its template variables when the old render lands later", async () => {
    const { result, rerender } = renderCommand()

    await typeName(result, "first")
    expect(renders).toHaveLength(1)

    // The runbook was edited and reloaded while the render was in flight
    rerender({ env: { NAME: "hello" } })
    expect(result.current.exec.isRendering).toBe(false)

    await act(async () => {
      renders[0]!.resolve(rendered("first"))
    })
    expect(shownName(result)).toBe("hello")
    expect(result.current.exec.isRendering).toBe(false)
  })
})
