import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, act, cleanup } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { makeTestApi, type HeldCall, type Params, type TestApi } from "@/test/test-api"
import { renderedInline } from "@/test/render-inline"
import { SENSITIVE_DISPLAY_RENDER_NOTE, useScriptExecution } from "../useScriptExecution"
import {
  isSensitiveOutput,
  revealOutputs,
  sensitiveOutput,
  type OutputValues,
} from "@/lib/outputValues"

// The hook runs inside the real RunbookContextProvider, so inputs and block
// outputs reach it through registerInputs/registerOutputs exactly as they do in
// the app. Only the contexts that would need their own providers, and the IPC
// bridge (handed to ApiProvider), are stubbed.
vi.mock("@/hooks/useExecutableRegistry", () => {
  const registry = {
    getExecutableByComponentId: (componentId: string) => ({
      id: `exec-${componentId}`,
      componentId,
    }),
    registryVersion: 0,
  }
  return { useExecutableRegistry: () => registry }
})
vi.mock("@/hooks/useGeneratedFiles", () => {
  const ctx = { updateGeneratedFileTree: () => {} }
  return { useGeneratedFiles: () => ctx }
})
vi.mock("@/contexts/useGitWorkTree", () => {
  const ctx = { invalidateGitFileTree: () => {} }
  return { useGitWorkTree: () => ctx }
})
vi.mock("@/contexts/useLogs", () => {
  const ctx = { registerLogs: () => {} }
  return { useLogs: () => ctx }
})

/**
 * Stands in for the boilerplate engine: substitutes each `{{ .inputs.x }}` /
 * `{{ .outputs.block.key }}` in every file from the payload the hook sends.
 */
function fakeRenderInline({ templateFiles, inputs }: Params<"boilerplate:render-inline">) {
  const ctx = Object.fromEntries(inputs.map((v) => [v.name, v.value]))
  const render = (template: string) =>
    template.replace(/\{\{\s*\.([\w.]+)\s*\}\}/g, (_, path: string) =>
      String(
        path.split(".").reduce<unknown>((obj, key) => (obj as Record<string, unknown>)[key], ctx),
      ),
    )
  return renderedInline(
    Object.fromEntries(Object.entries(templateFiles).map(([name, t]) => [name, render(t)])),
  )
}

let testApi: TestApi
/** Every exec:run, in call order. Each stays in flight until a test ends it. */
let heldRuns: readonly HeldCall<"exec:run">[]

beforeEach(() => {
  testApi = makeTestApi({
    "boilerplate:render-inline": fakeRenderInline,
    "exec:cancel": () => ({ ok: true }),
  })
  // Leave each run in flight: most tests only look at what was sent.
  heldRuns = testApi.hold("exec:run")
})

afterEach(() => {
  // Unmount first: the hook cancels its run on unmount.
  cleanup()
})

type Props = Omit<Parameters<typeof useScriptExecution>[0], "componentId" | "componentType">

function Providers({ children }: { children: ReactNode }) {
  return createElement(
    ApiProvider,
    { api: testApi.api },
    createElement(RunbookContextProvider, null, children),
  )
}

function renderScriptExecution(props: Props) {
  return renderHook(
    (p: Props) => ({
      exec: useScriptExecution({ componentId: "target", componentType: "command", ...p }),
      runbook: useRunbookContext(),
    }),
    { initialProps: props, wrapper: Providers },
  )
}

type EncodedOutputs = Record<string, { value: string; sensitive: boolean }>

/** Ends the latest exec:run, held open since it started, with a result. */
function holdRuns() {
  const settle = (result: Parameters<HeldCall<"exec:run">["resolve"]>[0]) =>
    act(async () => {
      heldRuns.at(-1)!.resolve(result)
    })
  return {
    finish: (status: "success" | "fail", exitCode: number, outputs: EncodedOutputs = {}) =>
      settle({ status: { status, exitCode }, outputs }),
    stop: () => settle({ status: null, cancelled: true }),
  }
}

function renderWithOutputs(props: Props, outputs: Record<string, OutputValues>) {
  const hook = renderScriptExecution(props)
  act(() => {
    for (const [blockId, values] of Object.entries(outputs)) {
      hook.result.current.runbook.registerOutputs(blockId, values)
    }
  })
  return hook
}

const renderCalls = () => testApi.callsTo("boilerplate:render-inline")

/** The value the block shows for its env var `name`. */
const envValue = (exec: ReturnType<typeof useScriptExecution>, name: string) =>
  exec.envVars.find((envVar) => envVar.name === name)?.value

describe("useScriptExecution — envFrom", () => {
  it("waits for each envFrom block that hasn't signed in, in envFrom's order", () => {
    const { result } = renderWithOutputs(
      { command: "deploy", envFrom: ["aws", "gh", "gcp"] },
      { gh: { __AUTHENTICATED: "true" } },
    )
    expect(result.current.exec.envFrom).toEqual(["aws", "gh", "gcp"])
    expect(result.current.exec.unsignedEnvFrom).toEqual(["aws", "gcp"])

    act(() => {
      result.current.runbook.registerOutputs("aws", { __AUTHENTICATED: "true" })
      result.current.runbook.registerOutputs("gcp", { __AUTHENTICATED: "true" })
    })
    expect(result.current.exec.unsignedEnvFrom).toEqual([])
  })

  it("waits again for a block that signed out", () => {
    const { result } = renderWithOutputs(
      { command: "deploy", envFrom: ["aws"] },
      { aws: { __AUTHENTICATED: "true" } },
    )
    expect(result.current.exec.unsignedEnvFrom).toEqual([])

    act(() => result.current.runbook.registerOutputs("aws", { __AUTHENTICATED: "false" }))
    expect(result.current.exec.unsignedEnvFrom).toEqual(["aws"])
  })

  it("finds a block named with hyphens under the id its outputs use", () => {
    const { result } = renderWithOutputs(
      { command: "deploy", envFrom: ["aws-prod"] },
      { "aws-prod": { __AUTHENTICATED: "true" } },
    )
    expect(result.current.exec.unsignedEnvFrom).toEqual([])
  })

  it("reports an envFrom that isn't a list of ids, and waits for nothing", () => {
    const { result } = renderScriptExecution({ command: "deploy", envFrom: "aws" })
    expect(result.current.exec.envFromError).toBe(
      'The envFrom prop must be a list of block ids, such as envFrom={["aws_prod"]}.',
    )
    expect(result.current.exec.envFrom).toEqual([])
    expect(result.current.exec.unsignedEnvFrom).toEqual([])
  })

  it("sends no env vars with the run: the main process adds the envFrom blocks' sign-ins", () => {
    const { result } = renderWithOutputs(
      { command: "aws sts get-caller-identity", envFrom: ["aws"] },
      {
        aws: {
          AWS_ACCESS_KEY_ID: "AKIA",
          __AUTHENTICATED: "true",
        },
      },
    )

    act(() => result.current.exec.execute())

    const [run] = testApi.callsTo("exec:run")
    expect(run).toEqual({
      executableId: "exec-target",
      templateVarValues: expect.any(Object),
      executionId: expect.any(String),
    })
  })
})

describe("useScriptExecution — template dependencies", () => {
  it("lists the inputs the env reads and waits for their values", () => {
    const { result } = renderScriptExecution({
      command: 'deploy "$ENV" "$REGION"',
      env: { ENV: "{{ .inputs.env }}", REGION: "{{ .inputs.region }}" },
      inputsId: "cfg",
    })
    expect(result.current.exec.inputDependencies).toEqual(["env", "region"])
    expect(result.current.exec.unmetInputDependencies).toEqual(["env", "region"])

    act(() =>
      result.current.runbook.registerInputs("cfg", { env: "prod", region: "" }, { variables: [] }),
    )
    expect(result.current.exec.unmetInputDependencies).toEqual(["region"])
    expect(result.current.exec.hasAllInputDependencies).toBe(false)
  })

  it("names the outputs it waits for", () => {
    const { result } = renderWithOutputs(
      { command: 'echo "$X $Y"', env: { X: "{{ .outputs.a.x }}", Y: "{{ .outputs.a.y }}" } },
      { a: { x: "1" } },
    )
    expect(result.current.exec.unmetOutputDependencies).toEqual([
      { blockId: "a", outputNames: ["y"] },
    ])
  })

  it("waits for an output that only its workingDir uses", () => {
    const { result } = renderScriptExecution({
      command: "tofu plan",
      workingDir: "{{ .outputs.clone.clone_path }}/live",
    })
    expect(result.current.exec.unmetOutputDependencies).toEqual([
      { blockId: "clone", outputNames: ["clone_path"] },
    ])
    expect(result.current.exec.outputDependencyBlockIds).toEqual(["clone"])

    act(() => result.current.runbook.registerOutputs("clone", { clone_path: "infra" }))
    expect(result.current.exec.hasAllOutputDependencies).toBe(true)
  })

  it("waits only for the block to run when the env guards an output with hasKey", () => {
    const { result } = renderScriptExecution({
      command: "gh repo list $ORG_FLAG",
      env: { ORG_FLAG: '{{ if hasKey .outputs.a "org" }}--org {{ .outputs.a.org }}{{ end }}' },
    })
    expect(result.current.exec.unmetOutputDependencies).toEqual([{ blockId: "a", outputNames: [] }])

    act(() => result.current.runbook.registerOutputs("a", { other: "1" }))
    expect(result.current.exec.hasAllOutputDependencies).toBe(true)
  })

  it("waits for nothing the script itself mentions", () => {
    const { result } = renderScriptExecution({ command: "docker ps --format '{{.Names}}'" })
    expect(result.current.exec.inputDependencies).toEqual([])
    expect(result.current.exec.unmetOutputDependencies).toEqual([])
    expect(result.current.exec.rawScriptContent).toBe("docker ps --format '{{.Names}}'")
  })
})

describe("useScriptExecution — outputs", () => {
  it("keeps a sensitive output wrapped, for display and for downstream blocks", async () => {
    const runs = holdRuns()
    const { result } = renderScriptExecution({ command: "mint-token" })

    act(() => result.current.exec.execute())
    await runs.finish("success", 0, {
      TOKEN: { value: "x", sensitive: true },
      user: { value: "u", sensitive: false },
    })

    // ViewOutputs gets the wrapped value, so it masks it
    const shown = result.current.exec.outputs ?? {}
    expect(isSensitiveOutput(shown.TOKEN!)).toBe(true)
    expect(shown.user).toBe("u")
    // Downstream blocks get the same, and read the real value through revealOutput
    const registered = result.current.runbook.blockOutputs.target?.values ?? {}
    expect(isSensitiveOutput(registered.TOKEN!)).toBe(true)
    expect(revealOutputs(registered)).toEqual({ TOKEN: "x", user: "u" })
  })

  it("publishes a finished run's outputs in the render that shows it succeeded", async () => {
    const runs = holdRuns()
    // What downstream blocks read in each render where the block shows success.
    // An empty map there leaves them "Waiting for outputs" from a block that
    // shows success and lists those outputs.
    const publishedOnSuccess: unknown[] = []
    const { result } = renderHook(
      () => {
        const exec = useScriptExecution({
          componentId: "target",
          componentType: "command",
          command: "create-accounts",
        })
        const runbook = useRunbookContext()
        if (exec.status === "success") publishedOnSuccess.push(runbook.blockOutputs.target?.values)
        return { exec, runbook }
      },
      { wrapper: Providers },
    )

    act(() => result.current.exec.execute())
    await runs.finish("success", 0, { AccountId: { value: "1", sensitive: false } })

    expect(result.current.exec.outputs).toEqual({ AccountId: "1" })
    expect(publishedOnSuccess.length).toBeGreaterThan(0)
    for (const published of publishedOnSuccess) {
      expect(published).toEqual({ AccountId: "1" })
    }
  })

  it("withdraws its outputs when a later run finishes without any", async () => {
    const runs = holdRuns()
    const { result } = renderScriptExecution({ command: "create-accounts" })
    act(() => result.current.exec.execute())
    await runs.finish("success", 0, { AccountId: { value: "1", sensitive: false } })
    expect(result.current.runbook.blockOutputs.target?.values).toEqual({ AccountId: "1" })

    act(() => result.current.exec.execute())
    await runs.finish("fail", 1)

    expect(result.current.runbook.blockOutputs.target?.values).toEqual({})
  })

  it("keeps its outputs when a later run is stopped", async () => {
    const runs = holdRuns()
    const { result } = renderScriptExecution({ command: "create-accounts" })
    act(() => result.current.exec.execute())
    await runs.finish("success", 0, { AccountId: { value: "1", sensitive: false } })

    act(() => result.current.exec.execute())
    await runs.stop()

    expect(result.current.runbook.blockOutputs.target?.values).toEqual({ AccountId: "1" })
  })
})

describe("useScriptExecution — template render", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it("renders once, 300ms after the last input change, and only the env", async () => {
    const { result } = renderScriptExecution({
      command: 'echo "$NAME"',
      env: { NAME: "{{ .inputs.name }}" },
      inputsId: "cfg",
    })

    act(() => result.current.runbook.registerInputs("cfg", { name: "w" }, { variables: [] }))
    await advance(200)
    act(() => result.current.runbook.registerInputs("cfg", { name: "wo" }, { variables: [] }))
    await advance(299)
    expect(renderCalls()).toHaveLength(0)

    await advance(1)
    expect(renderCalls()).toHaveLength(1)
    expect(Object.keys(renderCalls()[0]!.templateFiles)).toEqual(["env:NAME"])
    expect(envValue(result.current.exec, "NAME")).toBe("wo")
    expect(result.current.exec.rawScriptContent).toBe('echo "$NAME"')
  })

  it("does not render while an output dependency is missing", async () => {
    const { result } = renderScriptExecution({
      command: 'echo "$X"',
      env: { X: "{{ .outputs.a.x }}" },
    })

    await advance(1000)
    expect(renderCalls()).toHaveLength(0)
    expect(result.current.exec.hasAllOutputDependencies).toBe(false)
    expect(envValue(result.current.exec, "X")).toBe("{{ .outputs.a.x }}")
  })

  it("does not render when only its workingDir has templates", async () => {
    const { result } = renderScriptExecution({
      command: "tofu plan",
      workingDir: "{{ .outputs.clone.clone_path }}",
    })

    act(() => result.current.runbook.registerOutputs("clone", { clone_path: "infra" }))
    await advance(1000)
    expect(renderCalls()).toHaveLength(0)
    expect(result.current.exec.isRendering).toBe(false)
  })

  it("renders again when an output disappears and comes back with the same value", async () => {
    // A re-run of block A that fails without outputs registers {} for A, which
    // replaces its earlier values. When A succeeds again with the same value,
    // the render key matches the one from before, so the hook must not treat
    // it as already rendered: the display was cleared in between.
    const { result } = renderScriptExecution({
      command: 'echo "$X"',
      env: { X: "{{ .outputs.a.x }}" },
    })

    act(() => result.current.runbook.registerOutputs("a", { x: "foo" }))
    await advance(300)
    expect(envValue(result.current.exec, "X")).toBe("foo")

    act(() => result.current.runbook.registerOutputs("a", {}))
    await advance(300)
    expect(result.current.exec.hasAllOutputDependencies).toBe(false)
    expect(envValue(result.current.exec, "X")).toBe("{{ .outputs.a.x }}")

    act(() => result.current.runbook.registerOutputs("a", { x: "foo" }))
    await advance(300)
    expect(result.current.exec.hasAllOutputDependencies).toBe(true)
    expect(envValue(result.current.exec, "X")).toBe("foo")
  })

  it("shows a sensitive output as <redacted> in the rendered env, but runs with its real value", async () => {
    const { result } = renderScriptExecution({
      command: 'curl -H "Authorization: $TOKEN" "$URL"',
      env: { TOKEN: "{{ .outputs.a.token }}", URL: "{{ .outputs.a.url }}" },
    })

    act(() =>
      result.current.runbook.registerOutputs("a", {
        token: sensitiveOutput("s3cr3t"),
        url: "https://x",
      }),
    )
    await advance(300)

    // The env is only shown, so its render never gets the secret
    expect(envValue(result.current.exec, "TOKEN")).toBe("<redacted>")
    expect(envValue(result.current.exec, "URL")).toBe("https://x")
    expect(JSON.stringify(renderCalls())).not.toContain("s3cr3t")

    // The main process renders the env again, with the real value
    act(() => result.current.exec.execute())
    expect(testApi.invoke).toHaveBeenCalledWith(
      "exec:run",
      expect.objectContaining({
        templateVarValues: { inputs: {}, outputs: { a: { token: "s3cr3t", url: "https://x" } } },
      }),
    )
  })

  // The block renders `<redacted>`, which a template that parses the value
  // can't handle, as boilerplate's fromJson fails on it. The error says why,
  // since the run renders the real value and succeeds.
  describe("when the env render fails", () => {
    const FROM_JSON_ERROR =
      'template: env:USER:1:3: executing "env:USER" at <.outputs.a.creds>: nil data; no entry for key "user"'
    beforeEach(() => {
      testApi.handle("boilerplate:render-inline", () => {
        throw new Error(FROM_JSON_ERROR)
      })
    })

    it("explains it when the env uses a sensitive output", async () => {
      const { result } = renderScriptExecution({
        command: 'echo "user=$USER"',
        env: { USER: "{{ (fromJson .outputs.a.creds).user }}" },
      })

      act(() =>
        result.current.runbook.registerOutputs("a", { creds: sensitiveOutput('{"user":"bob"}') }),
      )
      await advance(300)

      expect(result.current.exec.renderError).toEqual({
        message: FROM_JSON_ERROR,
        details: SENSITIVE_DISPLAY_RENDER_NOTE,
      })
    })

    it("keeps the usual details when it does not", async () => {
      const { result } = renderScriptExecution({
        command: 'echo "user=$USER"',
        env: { USER: "{{ (fromJson .outputs.a.creds).user }}" },
      })

      act(() => result.current.runbook.registerOutputs("a", { creds: '{"user":"bob"}' }))
      await advance(300)

      expect(result.current.exec.renderError).toEqual({
        message: FROM_JSON_ERROR,
        details: "Failed to render the env with variables",
      })
    })
  })

  // An empty value reveals nothing, and the env's `{{ if }}` then takes the same branch as the run
  it("renders an empty sensitive output as empty in the env", async () => {
    const { result } = renderScriptExecution({
      command: 'echo "$TOKEN"',
      env: { TOKEN: "[{{ .outputs.a.token }}]" },
    })

    act(() => result.current.runbook.registerOutputs("a", { token: sensitiveOutput("") }))
    await advance(300)

    expect(envValue(result.current.exec, "TOKEN")).toBe("[]")
  })

  it("renders the new env when the env changes but the values do not", async () => {
    const { result, rerender } = renderScriptExecution({
      command: 'echo "$X"',
      env: { X: "echo {{ .outputs.a.x }}" },
    })

    act(() => result.current.runbook.registerOutputs("a", { x: "foo" }))
    await advance(300)
    expect(envValue(result.current.exec, "X")).toBe("echo foo")

    rerender({ command: 'echo "$X"', env: { X: "ls {{ .outputs.a.x }}" } })
    await advance(300)
    expect(envValue(result.current.exec, "X")).toBe("ls foo")
  })
})
