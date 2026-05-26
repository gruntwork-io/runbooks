import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  flattenVariables,
  resolveInputTemplates,
  stripTemplateValues,
  isTemplateString,
} from "./flattenInputs.ts"
import { WasmRuntime } from "../../services/WasmRuntime.ts"
import type { WasmRuntimeShape } from "../../services/WasmRuntime.ts"
import { WasmError } from "../../errors/index.ts"

// ---------------------------------------------------------------------------
// Fake WasmRuntime
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for `boilerplateRenderTemplate`. Supports
 *   {{ .inputs.<NAME> }}            → look up varsJSON.inputs[NAME]
 *   {{ .outputs.<BLOCK>.<FIELD> }}  → look up varsJSON.outputs[BLOCK][FIELD]
 *   {{ .<NAME> }}                   → look up varsJSON[NAME] (lifted top-level)
 * and reproduces the WASM build's OnMissingKey=ExitWithError behavior — if any
 * reference is missing, the whole render fails (returns a WasmError).
 *
 * This keeps tests free of a real WASM runtime while exercising the exact
 * decision tree resolveInputTemplates relies on (fail-or-fully-succeed, no
 * partial output).
 */
const NAMESPACED_REF_RE =
  /\{\{-?\s*\.(inputs|outputs)\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*-?\}\}/g
const TOPLEVEL_REF_RE = /\{\{-?\s*\.([a-zA-Z0-9_]+)\s*-?\}\}/g

function fakeRenderTemplate(
  template: string,
  varsJSON: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const vars = JSON.parse(varsJSON) as Record<string, unknown> & {
    inputs?: Record<string, unknown>
    outputs?: Record<string, Record<string, unknown>>
  }
  let missing: string | null = null
  // Namespaced refs first, so `.inputs.X` doesn't get partially matched by the
  // top-level pattern.
  let out = template.replace(NAMESPACED_REF_RE, (_match, ns, path: string) => {
    if (ns === "inputs") {
      const segments = path.split(".")
      let cur: unknown = vars.inputs ?? {}
      for (const seg of segments) {
        if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[seg]
        } else {
          missing ??= `inputs.${path}`
          return ""
        }
      }
      return cur == null ? "" : String(cur)
    }
    // outputs.<block>.<field>
    const dot = path.indexOf(".")
    if (dot < 0) {
      missing ??= `outputs.${path}`
      return ""
    }
    const block = path.slice(0, dot)
    const field = path.slice(dot + 1)
    const blockMap = vars.outputs?.[block]
    if (!blockMap || !(field in blockMap)) {
      missing ??= `outputs.${path}`
      return ""
    }
    const val = blockMap[field]
    return val == null ? "" : String(val)
  })
  out = out.replace(TOPLEVEL_REF_RE, (_match, name: string) => {
    if (!(name in vars)) {
      missing ??= name
      return ""
    }
    const val = vars[name]
    return val == null ? "" : String(val)
  })
  if (missing) return { ok: false, message: `missing key: ${missing}` }
  return { ok: true, value: out }
}

interface FakeWasmOptions {
  /** Force every renderTemplate call to fail (simulates load error / disabled). */
  alwaysFail?: boolean
  /** Optional spy hook — receives every (template, varsJSON) pair. */
  onCall?: (template: string, varsJSON: string) => void
}

function makeFakeWasm(options: FakeWasmOptions = {}): WasmRuntimeShape {
  const notImplemented = (name: string) =>
    Effect.die(`fake WasmRuntime: ${name} not implemented in flattenInputs.test`)
  return {
    renderTemplate: (template, varsJSON) =>
      Effect.suspend(() => {
        options.onCall?.(template, varsJSON)
        if (options.alwaysFail) {
          return Effect.fail(
            new WasmError({ message: "fake: alwaysFail", kind: "load" }),
          )
        }
        const result = fakeRenderTemplate(template, varsJSON)
        if (result.ok) return Effect.succeed(result.value)
        return Effect.fail(
          new WasmError({ message: result.message, kind: "internal" }),
        )
      }),
    renderFiles: () => notImplemented("renderFiles") as never,
    prepareBundle: () => notImplemented("prepareBundle") as never,
    renderFilesWithHandle: () => notImplemented("renderFilesWithHandle") as never,
    releaseBundle: () => Effect.void,
    inputsMap: () => notImplemented("inputsMap") as never,
    isReady: Effect.succeed(true),
  }
}

function fakeWasmLayer(options: FakeWasmOptions = {}) {
  return Layer.succeed(WasmRuntime, makeFakeWasm(options))
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isTemplateString", () => {
  it("matches Go-template syntax", () => {
    expect(isTemplateString("{{ .inputs.X }}")).toBe(true)
    expect(isTemplateString("hello {{ .x }} world")).toBe(true)
  })

  it("rejects non-templates", () => {
    expect(isTemplateString("plain string")).toBe(false)
    expect(isTemplateString("")).toBe(false)
    expect(isTemplateString(42)).toBe(false)
    expect(isTemplateString(null)).toBe(false)
    expect(isTemplateString(undefined)).toBe(false)
    expect(isTemplateString({})).toBe(false)
  })
})

describe("stripTemplateValues", () => {
  it("drops scalar templates and keeps literals", () => {
    expect(stripTemplateValues("{{ .x }}")).toBeUndefined()
    expect(stripTemplateValues("plain")).toBe("plain")
    expect(stripTemplateValues(7)).toBe(7)
  })

  it("strips template entries from a map", () => {
    expect(
      stripTemplateValues({ a: "x", b: "{{ .y }}" }),
    ).toEqual({ a: "x" })
  })

  it("drops an all-template map entirely", () => {
    expect(stripTemplateValues({ a: "{{ .x }}" })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveInputTemplates
// ---------------------------------------------------------------------------

describe("resolveInputTemplates", () => {
  it("returns inputs unchanged when no template strings are present", async () => {
    // No WASM call needed in this branch. Provide a fake that would die if called.
    const dieingWasm = Layer.succeed(WasmRuntime, makeFakeWasm({
      onCall: () => { throw new Error("renderTemplate should not be called") },
    }))
    const result = await Effect.runPromise(
      resolveInputTemplates({ A: "literal", B: 42 }, {}).pipe(
        Effect.provide(dieingWasm),
      ),
    )
    expect(result).toEqual({ A: "literal", B: 42 })
  })

  it("resolves a composed template against other inputs", async () => {
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          EmailUsername: "alice",
          EmailDomainName: "example.com",
          LogsAccountEmail: "{{ .inputs.EmailUsername }}+logsct5@{{ .inputs.EmailDomainName }}",
        },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result.LogsAccountEmail).toBe("alice+logsct5@example.com")
  })

  it("resolves all derived emails for the get-core-account-ids scenario", async () => {
    // Mirrors the bootstrap runbook: a Template block exposes three derived
    // email inputs (each composing EmailUsername + EmailDomainName) via
    // inputsId, alongside a concrete output. The downstream Command script
    // renders `{{ .inputs.LogsAccountEmail }}` etc., so these must resolve to
    // concrete addresses before the script runs.
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          EmailUsername: "acme",
          EmailDomainName: "example.com",
          LogsAccountEmail: "{{ .inputs.EmailUsername }}+logs@{{ .inputs.EmailDomainName }}",
          SecurityAccountEmail: "{{ .inputs.EmailUsername }}+security@{{ .inputs.EmailDomainName }}",
          SharedAccountEmail: "{{ .inputs.EmailUsername }}+shared@{{ .inputs.EmailDomainName }}",
        },
        { get_management_account: { ManagementAccountId: "145770590841" } },
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result.LogsAccountEmail).toBe("acme+logs@example.com")
    expect(result.SecurityAccountEmail).toBe("acme+security@example.com")
    expect(result.SharedAccountEmail).toBe("acme+shared@example.com")
  })

  it("leaves partially unresolvable templates as-is (one ref missing)", async () => {
    const original = "{{ .inputs.HaveThis }}+{{ .inputs.Missing }}@x"
    const result = await Effect.runPromise(
      resolveInputTemplates(
        { HaveThis: "alice", LogsAccountEmail: original },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    // OnMissingKey=ExitWithError means the whole render fails — we leave the
    // original template in place so the downstream strip pass drops it.
    expect(result.LogsAccountEmail).toBe(original)
  })

  it("preserves outputs references untouched in the input value (outputs in context)", async () => {
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          ManagementAccountEmail: "{{ .outputs.get_management_account.ManagementAccountEmail }}",
        },
        { get_management_account: { ManagementAccountEmail: "root@example.com" } },
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    // outputs are real values, so the template DOES resolve when outputs is
    // populated — this is the same surface used elsewhere in boilerplate.
    expect(result.ManagementAccountEmail).toBe("root@example.com")
  })

  it("falls back to original template when outputs context lacks the referenced field", async () => {
    const original = "{{ .outputs.never_ran.something }}"
    const result = await Effect.runPromise(
      resolveInputTemplates({ X: original }, {}).pipe(Effect.provide(fakeWasmLayer())),
    )
    // Missing output → render fails → we leave the original so strip + default
    // can do their job.
    expect(result.X).toBe(original)
  })

  it("resolves chained refs A → B → C across passes", async () => {
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          A: "{{ .inputs.B }}",
          B: "{{ .inputs.C }}",
          C: "leaf",
        },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result).toEqual({ A: "leaf", B: "leaf", C: "leaf" })
  })

  it("bails out on cycles without infinite looping", async () => {
    const original = {
      A: "{{ .inputs.B }}",
      B: "{{ .inputs.A }}",
    }
    const result = await Effect.runPromise(
      resolveInputTemplates(original, {}).pipe(Effect.provide(fakeWasmLayer())),
    )
    // Neither can resolve — both stay as their original templates.
    expect(result).toEqual(original)
  })

  it("treats every WASM call as a no-op when the runtime is failing", async () => {
    const original = {
      EmailUsername: "alice",
      LogsAccountEmail: "{{ .inputs.EmailUsername }}+x@y",
    }
    const result = await Effect.runPromise(
      resolveInputTemplates(original, {}).pipe(
        Effect.provide(fakeWasmLayer({ alwaysFail: true })),
      ),
    )
    // Same shape as the legacy behavior — strip pass downstream still cleans up.
    expect(result.EmailUsername).toBe("alice")
    expect(result.LogsAccountEmail).toBe(original.LogsAccountEmail)
  })

  it("resolves template expressions in map keys", async () => {
    // AccountDefaultTags default in bootstrap is exactly this shape:
    //   "{{ .OrgNamePrefix }}:AWSAccountName": "{{ .AWSAccountName }}"
    // Boilerplate does not re-render map keys in a var-file, so the key
    // must be resolved here or it ends up literal in the rendered output.
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          OrgNamePrefix: "acme",
          AWSAccountName: "logs",
          AccountDefaultTags: {
            "{{ .inputs.OrgNamePrefix }}:AWSAccountName": "{{ .inputs.AWSAccountName }}",
          },
        },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result.AccountDefaultTags).toEqual({
      "acme:AWSAccountName": "logs",
    })
  })

  it("resolves legacy top-level `{{ .X }}` refs in keys (no `.inputs.` prefix)", async () => {
    // The bootstrap runbook uses top-level refs throughout — `{{ .OrgNamePrefix }}`
    // rather than `{{ .inputs.OrgNamePrefix }}`. The resolver must expose lifted
    // inputs at the top level of the context for this to work.
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          OrgNamePrefix: "acme",
          AWSAccountName: "logs",
          AccountDefaultTags: {
            "{{ .OrgNamePrefix }}:AWSAccountName": "{{ .AWSAccountName }}",
          },
        },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result.AccountDefaultTags).toEqual({
      "acme:AWSAccountName": "logs",
    })
  })

  it("leaves an unresolvable key in place", async () => {
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          Known: "x",
          Tags: {
            "{{ .Missing }}:Team": "DevOps",
          },
        },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result.Tags).toEqual({
      "{{ .Missing }}:Team": "DevOps",
    })
  })

  it("descends into nested map / array inputs", async () => {
    const result = await Effect.runPromise(
      resolveInputTemplates(
        {
          Domain: "example.com",
          AWSAccounts: {
            logs: {
              email: "logs+{{ .inputs.Domain }}",
            },
            list: ["a@{{ .inputs.Domain }}", "static"],
          },
        },
        {},
      ).pipe(Effect.provide(fakeWasmLayer())),
    )
    expect(result).toEqual({
      Domain: "example.com",
      AWSAccounts: {
        logs: { email: "logs+example.com" },
        list: ["a@example.com", "static"],
      },
    })
  })
})

// ---------------------------------------------------------------------------
// flattenVariables — the public entry point used by the IPC handler.
// ---------------------------------------------------------------------------

describe("flattenVariables", () => {
  const run = (vars: Record<string, unknown> | undefined, options: FakeWasmOptions = {}) =>
    Effect.runPromise(
      flattenVariables(vars).pipe(Effect.provide(fakeWasmLayer(options))),
    )

  it("handles undefined / missing inputs", async () => {
    expect(await run(undefined)).toEqual({ inputs: {} })
    expect(await run({})).toEqual({ inputs: {} })
  })

  it("resolves a composed default and lifts it to the top level", async () => {
    const result = await run({
      inputs: {
        EmailUsername: "alice",
        EmailDomainName: "example.com",
        LogsAccountEmail: "{{ .inputs.EmailUsername }}+logsct5@{{ .inputs.EmailDomainName }}",
      },
      outputs: {},
    })
    expect(result.inputs).toEqual({
      EmailUsername: "alice",
      EmailDomainName: "example.com",
      LogsAccountEmail: "alice+logsct5@example.com",
    })
    // Lifted to top-level so legacy `{{ .LogsAccountEmail }}` access still works.
    expect(result.LogsAccountEmail).toBe("alice+logsct5@example.com")
  })

  it("strips an unresolvable input but keeps the rest", async () => {
    const result = await run({
      inputs: {
        EmailUsername: "alice",
        // Only one ref is resolvable; whole render fails; strip drops the value.
        LogsAccountEmail: "{{ .inputs.EmailUsername }}+x@{{ .inputs.Missing }}",
      },
      outputs: {},
    })
    expect(result.inputs).toEqual({ EmailUsername: "alice" })
    expect("LogsAccountEmail" in result).toBe(false)
  })

  it("preserves outputs verbatim and lets boilerplate-style output refs reach it", async () => {
    const outputs = {
      get_management_account: { ManagementAccountEmail: "root@example.com" },
    }
    const result = await run({
      inputs: {
        // This is what AWSAccounts.management.email looks like in real
        // runbooks — a default that references an upstream block output.
        ManagementAccountEmail: "{{ .outputs.get_management_account.ManagementAccountEmail }}",
      },
      outputs,
    })
    // The outputs namespace must reach boilerplate unchanged for .hcl files
    // that reference it directly.
    expect(result.outputs).toEqual(outputs)
    // And our resolution pass also turned the input value into the resolved
    // email so it flows through as a literal.
    expect(result.inputs).toEqual({
      ManagementAccountEmail: "root@example.com",
    })
  })

  it("keeps an outputs-referencing input as a template when outputs is empty (legacy strip path still works)", async () => {
    const result = await run({
      inputs: {
        ManagementAccountEmail: "{{ .outputs.get_management_account.ManagementAccountEmail }}",
      },
      outputs: {},
    })
    // No outputs yet → render fails → strip drops the value → boilerplate's
    // own `default:` evaluation runs in the parent scope. This is the
    // pre-existing behavior that the bootstrap runbook depends on.
    expect(result.inputs).toEqual({})
    expect("ManagementAccountEmail" in result).toBe(false)
  })

  it("respects the input/output reserved names when lifting", async () => {
    // `inputs` and `outputs` inside the inputs namespace must NOT clobber the
    // top-level namespaces of the same name.
    const result = await run({
      inputs: { Foo: "bar", inputs: "should-not-lift", outputs: "neither" },
      outputs: { block: { x: "1" } },
    })
    expect(result.Foo).toBe("bar")
    // Top-level inputs/outputs preserved as namespaces (not the lifted strings).
    expect(result.inputs).toEqual({ Foo: "bar", inputs: "should-not-lift", outputs: "neither" })
    expect(result.outputs).toEqual({ block: { x: "1" } })
  })

  it("explicit root-level keys win over lifted inputs", async () => {
    const result = await run({
      Foo: "root-wins",
      inputs: { Foo: "lifted-loses" },
    })
    expect(result.Foo).toBe("root-wins")
  })
})
