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
import { SessionHistoryContext, type SessionHistory } from "@/contexts/SessionHistoryContext.types"
import { isSensitiveOutput, revealOutput, sensitiveOutput } from "@/lib/outputValues"
import { TestWrapper } from "@/test/test-utils"
import { makeTestApi, type HeldCall, type TestApi } from "@/test/test-api"
import { makeConfig } from "@/test/make-config"
import { renderedInline } from "@/test/render-inline"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { Executable } from "@/types/executable"
import { useScriptExecution } from "../useScriptExecution"
import { outputRef } from "../../lib/outputOverrides"

let testApi: TestApi
// `boilerplate:render-inline` calls stay pending until the test settles them.
let renders: readonly HeldCall<"boilerplate:render-inline">[]

let registered: Executable | null = null
const registry: ExecutableRegistryContextValue = {
  getExecutableByComponentId: () => registered,
  registryVersion: 0,
}

// The session's history: what a block saved, and what it records
let saved: Record<string, unknown> = {}
const record = vi.fn()
const history: SessionHistory = {
  saved: (blockId, kind) => saved[`${blockId}/${kind}`],
  record,
  finish: () => {},
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ApiProvider api={testApi.api}>
      <SessionHistoryContext.Provider value={history}>
        <TestWrapper>
          <ExecutableRegistryContext.Provider value={registry}>
            <GeneratedFilesProvider>
              <IpcGitWorkTreeProvider>
                <LogsProvider>{children}</LogsProvider>
              </IpcGitWorkTreeProvider>
            </GeneratedFilesProvider>
          </ExecutableRegistryContext.Provider>
        </TestWrapper>
      </SessionHistoryContext.Provider>
    </ApiProvider>
  )
}

const config = makeConfig([{ name: "BucketName", type: BoilerplateVariableType.String }])
const COMMAND = 'aws s3 mb "s3://$BUCKET"'

function renderCommand(
  env: unknown,
  workingDir?: unknown,
  { interpreter, command = COMMAND }: { interpreter?: unknown; command?: string } = {},
) {
  return renderHook(
    () => ({
      exec: useScriptExecution({
        componentId: "make-bucket",
        command,
        inputsId: "form",
        componentType: "command",
        env,
        workingDir,
        interpreter,
      }),
      runbook: useRunbookContext(),
    }),
    { wrapper: Providers },
  )
}

beforeEach(() => {
  testApi = makeTestApi({ "native:set-theme": () => ({ ok: true }) })
  renders = testApi.hold("boilerplate:render-inline")
  // A run that never ends, so the test can read what it was sent
  testApi.hold("exec:run")
  record.mockClear()
  saved = {}
  registered = null
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useScriptExecution — env prop", () => {
  it("waits for the inputs its env references, then shows the env rendered", async () => {
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

    // One render, for the env values that are templates. The script runs as written.
    expect(renders).toHaveLength(1)
    expect(renders[0]!.params.templateFiles).toEqual({ "env:BUCKET": "{{ .inputs.BucketName }}" })

    await act(async () => {
      renders[0]!.resolve(renderedInline({ "env:BUCKET": "my-bucket" }))
    })
    expect(result.current.exec.rawScriptContent).toBe(COMMAND)
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
      workingDir: "",
      interpreter: "",
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

  it("says why a workingDir prop isn't valid, and keeps none", () => {
    for (const workingDir of [3, ""]) {
      const { exec } = renderCommand(undefined, workingDir).result.current
      expect(exec.workingDirError).toBe(
        'The workingDir prop must be a path, such as workingDir="infra/live".',
      )
      expect(exec.workingDirTemplate).toBe("")
    }

    const { exec } = renderCommand(undefined, "{{ .inputs.Dir }}").result.current
    expect(exec.workingDirError).toBeNull()
    expect(exec.workingDirTemplate).toBe("{{ .inputs.Dir }}")
  })

  it("flags drift when the workingDir Run will use isn't the block's", () => {
    const env = { BUCKET: "{{ .inputs.BucketName }}" }
    registered = {
      id: "e1",
      type: "inline",
      componentId: "make-bucket",
      componentType: "command",
      contentHash: "hash-of-the-command",
      env,
      workingDir: "infra",
      interpreter: "",
    }

    expect(renderCommand(env, "infra").result.current.exec.hasScriptDrift).toBe(false)
    expect(renderCommand(env, "infra/live").result.current.exec.hasScriptDrift).toBe(true)
    expect(renderCommand(env).result.current.exec.hasScriptDrift).toBe(true)
  })

  it("says why an interpreter prop isn't valid, and keeps none", () => {
    for (const interpreter of [3, "  "]) {
      const { exec } = renderCommand(undefined, undefined, { interpreter }).result.current
      expect(exec.interpreterError).toBe(
        'The interpreter prop must name a program, such as interpreter="python3".',
      )
      expect(exec.interpreter).toBe("")
    }

    const { exec } = renderCommand(undefined, undefined, { interpreter: " deno run " }).result
      .current
    expect(exec.interpreterError).toBeNull()
    expect(exec.interpreter).toBe("deno run")
  })

  it("refuses an interpreter prop on a script that has a shebang", () => {
    const { exec } = renderCommand(undefined, undefined, {
      interpreter: "python3",
      command: "#!/usr/bin/env python3\nprint(1)",
    }).result.current

    expect(exec.interpreterError).toBe(
      "The script starts with a shebang line, and the block sets the interpreter prop. Remove one of them.",
    )
  })

  it("flags drift when the interpreter Run will use isn't the block's", () => {
    const env = { BUCKET: "{{ .inputs.BucketName }}" }
    registered = {
      id: "e1",
      type: "inline",
      componentId: "make-bucket",
      componentType: "command",
      contentHash: "hash-of-the-command",
      env,
      workingDir: "",
      interpreter: "python3",
    }
    const drift = (interpreter?: string) =>
      renderCommand(env, undefined, { interpreter }).result.current.exec.hasScriptDrift

    expect(drift("python3")).toBe(false)
    expect(drift("node")).toBe(true)
    expect(drift()).toBe(true)
  })
})

describe("useScriptExecution — outputs entered by hand", () => {
  const PRINT = 'echo "$PR_TITLE"'
  const title = outputRef("fetch-pr", "title")

  function renderPrinter() {
    return renderHook(
      () => ({
        exec: useScriptExecution({
          componentId: "print-title",
          command: PRINT,
          componentType: "command",
          env: { PR_TITLE: "{{ .outputs.fetch-pr.title }}" },
        }),
        runbook: useRunbookContext(),
      }),
      { wrapper: Providers },
    )
  }

  /** The outputs a render request rendered the env with. */
  function renderedOutputs(render: HeldCall<"boilerplate:render-inline">) {
    return (render.params.inputs ?? []).find((input) => input.name === "outputs")!.value
  }

  it("stops waiting for an output given by hand, and waits again once it's reset", async () => {
    const { result } = renderPrinter()

    expect(result.current.exec.hasAllOutputDependencies).toBe(false)
    expect(result.current.exec.outputDependencyBlockIds).toEqual(["fetch-pr"])
    expect(result.current.exec.envVars).toEqual([
      {
        name: "PR_TITLE",
        value: "{{ .outputs.fetch-pr.title }}",
        parts: [{ kind: "output", ref: title, output: undefined, override: undefined }],
      },
    ])

    await act(async () => {
      result.current.exec.overrideOutput(title, "Fix it")
    })

    expect(result.current.exec.hasAllOutputDependencies).toBe(true)
    expect(result.current.exec.outputDependencyBlockIds).toEqual([])
    expect(result.current.exec.envVars[0]!.parts).toEqual([
      { kind: "output", ref: title, output: undefined, override: "Fix it" },
    ])
    expect(record).toHaveBeenLastCalledWith("print-title", "overrides", {
      outputs: { fetch_pr: { title: { value: "Fix it", sensitive: false } } },
    })

    // The env renders with the value entered
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(renders).toHaveLength(1)
    expect(renders[0]!.params.templateFiles).toEqual({
      "env:PR_TITLE": "{{ .outputs.fetch-pr.title }}",
    })
    expect(renderedOutputs(renders[0]!)).toEqual({ fetch_pr: { title: "Fix it" } })

    await act(async () => {
      result.current.exec.resetOutputOverride(title)
    })

    expect(result.current.exec.hasAllOutputDependencies).toBe(false)
    expect(result.current.exec.envVars[0]!.value).toBe("{{ .outputs.fetch-pr.title }}")
    expect(record).toHaveBeenLastCalledWith("print-title", "overrides", { outputs: {} })
  })

  it("uses a value given by hand in place of the block's output, and runs with it", async () => {
    registered = {
      id: "e1",
      type: "inline",
      componentId: "print-title",
      componentType: "command",
      contentHash: "hash-of-the-command",
      env: { PR_TITLE: "{{ .outputs.fetch-pr.title }}" },
      workingDir: "",
      interpreter: "",
    }
    const { result } = renderPrinter()
    await act(async () => {
      result.current.runbook.registerOutputs("fetch-pr", { title: "Old title", url: "https://x" })
    })
    expect(result.current.exec.envVars[0]!.parts).toEqual([
      { kind: "output", ref: title, output: "Old title", override: undefined },
    ])

    await act(async () => {
      result.current.exec.overrideOutput(title, "New title")
    })
    expect(result.current.exec.templateContext.outputs.fetch_pr).toEqual({
      title: "New title",
      url: "https://x",
    })

    await act(async () => {
      result.current.exec.execute()
    })
    expect(testApi.callsTo("exec:run")[0]).toMatchObject({
      executableId: "e1",
      templateVarValues: { outputs: { fetch_pr: { title: "New title", url: "https://x" } } },
    })
  })

  it("shows a secret given by hand as one, and runs with its real value", async () => {
    registered = {
      id: "e1",
      type: "inline",
      componentId: "print-title",
      componentType: "command",
      contentHash: "hash-of-the-command",
      env: { PR_TITLE: "{{ .outputs.fetch-pr.title }}" },
      workingDir: "",
      interpreter: "",
    }
    const { result } = renderPrinter()

    await act(async () => {
      result.current.exec.overrideOutput(title, sensitiveOutput("s3cr3t"))
    })
    expect(record).toHaveBeenLastCalledWith("print-title", "overrides", {
      outputs: { fetch_pr: { title: { value: "s3cr3t", sensitive: true } } },
    })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(renderedOutputs(renders[0]!)).toEqual({ fetch_pr: { title: "<redacted>" } })

    await act(async () => {
      result.current.exec.execute()
    })
    expect(testApi.callsTo("exec:run")[0]).toMatchObject({
      templateVarValues: { outputs: { fetch_pr: { title: "s3cr3t" } } },
    })
  })

  it("starts from the values the session has for the outputs its env reads", () => {
    saved["print-title/overrides"] = {
      outputs: {
        fetch_pr: { title: { value: "s3cr3t", sensitive: true } },
        // An output the env no longer reads
        build: { tag: { value: "v2", sensitive: false } },
      },
    }
    const { result } = renderPrinter()

    expect(result.current.exec.hasAllOutputDependencies).toBe(true)
    const [part] = result.current.exec.envVars[0]!.parts!
    const override = part?.kind === "output" ? part.override : undefined
    expect(override !== undefined && isSensitiveOutput(override)).toBe(true)
    expect(revealOutput(override)).toBe("s3cr3t")
    expect(result.current.exec.templateContext.outputs).not.toHaveProperty("build")
  })
})
