import { describe, it, expect } from "bun:test"
import { Effect, Either, Layer } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { renderScriptForExec } from "./render.ts"
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
        catch: (err) =>
          new WasmError({ message: (err as Error).message, kind: "internal" }),
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

function render(script: string, vars: Record<string, unknown>) {
  return Effect.runPromise(
    Effect.either(renderScriptForExec(script, vars)).pipe(Effect.provide(testLayer)),
  )
}

async function renderOk(script: string, vars: Record<string, unknown>): Promise<string> {
  const result = await render(script, vars)
  if (Either.isLeft(result)) throw result.left
  return result.right
}

// ---------------------------------------------------------------------------
// renderScriptForExec
// ---------------------------------------------------------------------------

describe("renderScriptForExec", () => {
  it("inserts input values verbatim inside the script's own quotes", async () => {
    const out = await renderOk('TARGET_SA="{{ .inputs.A }}"', {
      inputs: { A: "sa@p.iam.gserviceaccount.com" },
    })
    expect(out).toBe('TARGET_SA="sa@p.iam.gserviceaccount.com"')
  })

  // Checks the no-escaping contract at the WASM boundary itself, so it does
  // not depend on how faithfully fakeGoTemplate models text/template.
  it("hands the renderer raw, unquoted values", async () => {
    const script = 'A="{{ .inputs.A }}" U="{{ .outputs.b.URL }}"'
    renderCalls.length = 0
    await renderOk(script, {
      inputs: { A: "my repo" },
      outputs: { b: { URL: "https://example.com/x?y=1" } },
    })
    const scriptCall = renderCalls.find((c) => c.template === script)
    expect(scriptCall).toBeDefined()
    expect(JSON.parse(scriptCall!.varsJSON)).toEqual({
      inputs: { A: "my repo" },
      outputs: { b: { URL: "https://example.com/x?y=1" } },
    })
  })

  it("inserts block outputs verbatim", async () => {
    const out = await renderOk('PR_URL="{{ .outputs.pr_scaffold.PR_URL }}"', {
      inputs: {},
      outputs: { pr_scaffold: { PR_URL: "https://github.com/acme/infra/pull/7" } },
    })
    expect(out).toBe('PR_URL="https://github.com/acme/infra/pull/7"')
  })

  it("compares the raw value in eq conditions", async () => {
    const out = await renderOk('{{ if eq .inputs.L "JavaScript" }}yes{{ end }}', {
      inputs: { L: "JavaScript" },
    })
    expect(out).toBe("yes")
  })

  it("honors every eq branch in the next-app sample script", async () => {
    const script = nodeFs.readFileSync(
      nodePath.join(
        import.meta.dirname,
        "../../../testdata/sample-runbooks/next-app/scripts/create-next-app.sh",
      ),
      "utf8",
    )
    const out = await renderOk(script, {
      inputs: {
        ImportAlias: "@/*",
        Language: "JavaScript",
        UseTailwind: "Yes",
        Bundler: "Webpack",
      },
    })
    expect(out).toContain('--import-alias "@/*")')
    expect(out).toContain("ARGS+=(--javascript)")
    expect(out).toContain("ARGS+=(--tailwind)")
    expect(out).toContain("ARGS+=(--webpack)")
    expect(out).not.toContain("--typescript")
    expect(out).not.toContain("--turbopack")
  })

  it("resolves nested input templates before rendering the script", async () => {
    const out = await renderOk('EMAIL="{{ .inputs.LogsEmail }}"', {
      inputs: {
        User: "ops",
        Domain: "example.com",
        LogsEmail: "{{ .inputs.User }}+logs@{{ .inputs.Domain }}",
      },
    })
    expect(out).toBe('EMAIL="ops+logs@example.com"')
  })

  // Go-template text meant for another tool is the realistic way to reach
  // exec with a broken template: the UI only gates Run on .inputs/.outputs.
  it("fails with the template error instead of returning a marker as the script", async () => {
    const result = await render("docker ps --format '{{.Names}}'", { inputs: {} })
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RenderError)
      expect(result.left.message).toContain('map has no entry for key "Names"')
    }
  })
})
