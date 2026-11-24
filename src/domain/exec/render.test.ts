import { describe, it, expect } from "bun:test"
import { Effect, Result, Layer } from "effect"
import { renderBlockEnv, renderBlockWorkingDir } from "./render.ts"
import { WasmBoilerplateLive } from "../../layers/WasmBoilerplate.ts"
import { WasmRuntime } from "../../services/WasmRuntime.ts"
import type { WasmRuntimeShape } from "../../services/WasmRuntime.ts"
import { RenderError, WasmError } from "../../errors/index.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import { makeTestSpawner } from "../../test-utils/TestSpawner.ts"

// ---------------------------------------------------------------------------
// Fake WasmRuntime
// ---------------------------------------------------------------------------

/**
 * Just enough Go text/template for these tests: `{{ .a.b }}` lookups,
 * `{{ if .a }}` / `{{ if eq .a "lit" }}` with `{{ else }}` / `{{ end }}`, and
 * `{{-` / `-}}` whitespace trimming. Like text/template, values are inserted
 * as-is (no escaping of its own), and like the WASM build
 * (`OnMissingKey=ExitWithError`) a missing key or unknown action fails the
 * whole render.
 */
function fakeGoTemplate(template: string, vars: Record<string, unknown>): string {
  const lookup = (path: string): unknown => {
    let cur: unknown = vars
    for (const seg of path.slice(1).split(".")) {
      if (cur === null || typeof cur !== "object" || !(seg in cur)) {
        throw new Error(`executing at <${path}>: map has no entry for key "${seg}"`)
      }
      cur = (cur as Record<string, unknown>)[seg]
    }
    return cur
  }
  const evalCond = (expr: string): boolean => {
    const eq = expr.match(/^eq\s+(\.\S+)\s+"([^"]*)"$/)
    if (eq) return lookup(eq[1]!) === eq[2]
    if (expr.startsWith(".")) return Boolean(lookup(expr))
    throw new Error(`unsupported condition: ${expr}`)
  }

  const frames: Array<{ cond: boolean; inElse: boolean }> = []
  const emitting = () => frames.every((f) => (f.inElse ? !f.cond : f.cond))
  let out = ""
  let trimNext = false
  let last = 0
  const emitText = (text: string, trimEnd: boolean) => {
    let t = trimNext ? text.trimStart() : text
    if (trimEnd) t = t.trimEnd()
    if (emitting()) out += t
  }
  for (const m of template.matchAll(/\{\{(-?)\s*(.*?)\s*(-?)\}\}/gs)) {
    emitText(template.slice(last, m.index), m[1] === "-")
    trimNext = m[3] === "-"
    last = m.index! + m[0].length
    const body = m[2]!
    if (body.startsWith("if ")) {
      frames.push({ cond: emitting() && evalCond(body.slice(3).trim()), inElse: false })
    } else if (body === "else") {
      frames[frames.length - 1]!.inElse = true
    } else if (body === "end") {
      frames.pop()
    } else if (body.startsWith(".")) {
      if (emitting()) out += String(lookup(body))
    } else {
      throw new Error(`function "${body.split(/\s+/)[0]}" not defined`)
    }
  }
  emitText(template.slice(last), false)
  return out
}

/** Every `(template, varsJSON)` pair the fake WASM bridge was asked to render. */
const renderCalls: Array<{ template: string; varsJSON: string }> = []

function makeFakeWasm(): WasmRuntimeShape {
  const notImplemented = (name: string) =>
    Effect.die(`fake WasmRuntime: ${name} not implemented in render.test`)
  return {
    renderTemplate: (template, varsJSON) =>
      Effect.try({
        try: () => {
          renderCalls.push({ template, varsJSON })
          return fakeGoTemplate(template, JSON.parse(varsJSON))
        },
        catch: (err) => new WasmError({ message: (err as Error).message, kind: "internal" }),
      }),
    renderFiles: () => notImplemented("renderFiles") as never,
    prepareBundle: () => notImplemented("prepareBundle") as never,
    renderFilesWithHandle: () => notImplemented("renderFilesWithHandle") as never,
    releaseBundle: () => Effect.void,
    isReady: Effect.succeed(true),
  }
}

// The real renderer layer over the fake WASM bridge. resolveInputTemplates
// talks to WasmRuntime directly, so it is exposed as well.
const wasmLayer = Layer.succeed(WasmRuntime, makeFakeWasm())
const testLayer = Layer.merge(
  Layer.provide(
    WasmBoilerplateLive,
    Layer.mergeAll(makeTestFileSystem(), makeTestSpawner(), wasmLayer),
  ),
  wasmLayer,
)

// ---------------------------------------------------------------------------
// renderBlockEnv
// ---------------------------------------------------------------------------

function renderEnv(env: Record<string, string>, vars: Record<string, unknown>) {
  return Effect.runPromise(Effect.result(renderBlockEnv(env, vars)).pipe(Effect.provide(testLayer)))
}

describe("renderBlockEnv", () => {
  it("renders each value with the block's inputs and outputs, keeping what an output holds as it is", async () => {
    const title = 'Fix typo $(touch /tmp/runbooks-pwned) "; rm -rf ~; echo "'
    const result = await renderEnv(
      {
        BUCKET: "{{ .inputs.BucketName }}",
        PR_TITLE: "{{ .outputs.fetch_pr.TITLE }}",
        LABEL: "release",
      },
      { inputs: { BucketName: "my-bucket" }, outputs: { fetch_pr: { TITLE: title } } },
    )

    expect(result).toEqual(
      Result.succeed({ BUCKET: "my-bucket", PR_TITLE: title, LABEL: "release" }),
    )
  })

  it("resolves an input that is a template itself", async () => {
    const result = await renderEnv(
      { EMAIL: "{{ .inputs.LogsEmail }}" },
      {
        inputs: {
          User: "ops",
          Domain: "example.com",
          LogsEmail: "{{ .inputs.User }}+logs@{{ .inputs.Domain }}",
        },
      },
    )
    expect(result).toEqual(Result.succeed({ EMAIL: "ops+logs@example.com" }))
  })

  it("fails, naming the variable, when a value references an output that doesn't exist", async () => {
    const result = await renderEnv(
      { PR_TITLE: "{{ .outputs.fetch_pr.TITLE }}" },
      { inputs: {}, outputs: {} },
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RenderError)
      expect(result.failure.message).toStartWith("PR_TITLE in env: ")
    }
  })

  it("renders nothing for literal values and an empty env", async () => {
    renderCalls.length = 0
    expect(await renderEnv({ LABEL: "release" }, {})).toEqual(Result.succeed({ LABEL: "release" }))
    expect(await renderEnv({}, {})).toEqual(Result.succeed({}))
    expect(renderCalls).toEqual([])
  })
})

function renderWorkingDir(workingDir: string, vars: Record<string, unknown>) {
  return Effect.runPromise(
    Effect.result(renderBlockWorkingDir(workingDir, vars)).pipe(Effect.provide(testLayer)),
  )
}

describe("renderBlockWorkingDir", () => {
  it("renders the path with the block's inputs and outputs", async () => {
    const result = await renderWorkingDir("{{ .outputs.clone.clone_path }}/live", {
      inputs: {},
      outputs: { clone: { clone_path: "infra" } },
    })
    expect(result).toEqual(Result.succeed("infra/live"))
  })

  it("fails, naming the prop, when the path references an output that doesn't exist", async () => {
    const result = await renderWorkingDir("{{ .outputs.clone.clone_path }}", {
      inputs: {},
      outputs: {},
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toStartWith("workingDir: ")
  })

  it("renders nothing for a literal path", async () => {
    renderCalls.length = 0
    expect(await renderWorkingDir("infra/live", {})).toEqual(Result.succeed("infra/live"))
    expect(renderCalls).toEqual([])
  })
})
