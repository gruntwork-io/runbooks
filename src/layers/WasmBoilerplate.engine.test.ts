/**
 * Template engine tests: covers `if`/`else if` predicates beyond truthy,
 * pipe-with-function-table, and scoped `range` nesting.
 *
 * These tests exercise the renderer through the public `renderFile` Effect so
 * they go through the same Layer wiring as the IPC handler.
 */
import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { WasmBoilerplateLive } from "./WasmBoilerplate.ts"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"

const layer = Layer.provide(WasmBoilerplateLive, makeTestFileSystem({}))

/** Helper: run renderFile and unwrap the Effect to a plain string. */
async function render(content: string, vars: Record<string, unknown>): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const r = yield* BoilerplateRenderer
      return yield* r.renderFile(content, vars)
    }).pipe(Effect.provide(layer)),
  )
}

// ---------------------------------------------------------------------------
// 7. `if` predicates beyond truthy
// ---------------------------------------------------------------------------

describe("renderGoTemplate: eq predicate", () => {
  it("matches an equal string literal", async () => {
    const out = await render(`{{ if eq .x "hi" }}YES{{ else }}NO{{ end }}`, { x: "hi" })
    expect(out).toBe("YES")
  })
  it("does not match a different string literal", async () => {
    const out = await render(`{{ if eq .x "hi" }}YES{{ else }}NO{{ end }}`, { x: "bye" })
    expect(out).toBe("NO")
  })
})

describe("renderGoTemplate: ne predicate", () => {
  it("matches when values differ", async () => {
    const out = await render(`{{ if ne .x "hi" }}YES{{ else }}NO{{ end }}`, { x: "bye" })
    expect(out).toBe("YES")
  })
  it("does not match when values are equal", async () => {
    const out = await render(`{{ if ne .x "hi" }}YES{{ else }}NO{{ end }}`, { x: "hi" })
    expect(out).toBe("NO")
  })
})

describe("renderGoTemplate: not predicate", () => {
  it("returns true branch when value is falsy", async () => {
    const out = await render(`{{ if not .x }}YES{{ else }}NO{{ end }}`, { x: "" })
    expect(out).toBe("YES")
  })
  it("returns else branch when value is truthy", async () => {
    const out = await render(`{{ if not .x }}YES{{ else }}NO{{ end }}`, { x: "hi" })
    expect(out).toBe("NO")
  })
})

describe("renderGoTemplate: or predicate with grouped sub-expressions", () => {
  it("matches when first sub-expression is true", async () => {
    const out = await render(
      `{{ if or (eq .x "a") (eq .x "b") }}MATCH{{ else }}MISS{{ end }}`,
      { x: "a" },
    )
    expect(out).toBe("MATCH")
  })
  it("matches when second sub-expression is true", async () => {
    const out = await render(
      `{{ if or (eq .x "a") (eq .x "b") }}MATCH{{ else }}MISS{{ end }}`,
      { x: "b" },
    )
    expect(out).toBe("MATCH")
  })
  it("does not match when neither sub-expression is true", async () => {
    const out = await render(
      `{{ if or (eq .x "a") (eq .x "b") }}MATCH{{ else }}MISS{{ end }}`,
      { x: "c" },
    )
    expect(out).toBe("MISS")
  })
})

describe("renderGoTemplate: and predicate with grouped sub-expressions", () => {
  it("matches when both sub-expressions are true", async () => {
    const out = await render(
      `{{ if and (not .x) (eq .y "z") }}MATCH{{ else }}MISS{{ end }}`,
      { x: "", y: "z" },
    )
    expect(out).toBe("MATCH")
  })
  it("does not match when one sub-expression is false", async () => {
    const out = await render(
      `{{ if and (not .x) (eq .y "z") }}MATCH{{ else }}MISS{{ end }}`,
      { x: "set", y: "z" },
    )
    expect(out).toBe("MISS")
  })
})

describe("renderGoTemplate: integer literal in eq", () => {
  it("matches when integer values are equal", async () => {
    const out = await render(`{{ if eq .n 42 }}YES{{ else }}NO{{ end }}`, { n: 42 })
    expect(out).toBe("YES")
  })
  it("does not match across number/string types (Go semantics)", async () => {
    const out = await render(`{{ if eq .n 42 }}YES{{ else }}NO{{ end }}`, { n: "42" })
    expect(out).toBe("NO")
  })
})

describe("renderGoTemplate: boolean literal in eq", () => {
  it("matches when bool values are equal", async () => {
    const out = await render(`{{ if eq .b true }}YES{{ else }}NO{{ end }}`, { b: true })
    expect(out).toBe("YES")
  })
  it("does not match when bool differs", async () => {
    const out = await render(`{{ if eq .b true }}YES{{ else }}NO{{ end }}`, { b: false })
    expect(out).toBe("NO")
  })
})

// ---------------------------------------------------------------------------
// 8. else-if chains
// ---------------------------------------------------------------------------

describe("renderGoTemplate: 4-branch if/else-if/else-if/else chain", () => {
  const tpl = `{{ if eq .x "a" }}A{{ else if eq .x "b" }}B{{ else if eq .x "c" }}C{{ else }}D{{ end }}`
  it("first branch wins for a", async () => {
    expect(await render(tpl, { x: "a" })).toBe("A")
  })
  it("second branch wins for b", async () => {
    expect(await render(tpl, { x: "b" })).toBe("B")
  })
  it("third branch wins for c", async () => {
    expect(await render(tpl, { x: "c" })).toBe("C")
  })
  it("else branch wins for unmatched", async () => {
    expect(await render(tpl, { x: "z" })).toBe("D")
  })
})

// ---------------------------------------------------------------------------
// 9. Pipes with function table
// ---------------------------------------------------------------------------

describe("renderGoTemplate: simple pipe operations", () => {
  it("upper", async () => {
    expect(await render(`{{ "hello" | upper }}`, {})).toBe("HELLO")
  })
  it("lower", async () => {
    expect(await render(`{{ "HELLO" | lower }}`, {})).toBe("hello")
  })
  it("quote", async () => {
    expect(await render(`{{ "hi \\"there\\"" | quote }}`, {})).toBe(`"hi \\"there\\""`)
  })
  it("default fallback when input is empty", async () => {
    expect(await render(`{{ .x | default "fb" }}`, { x: "" })).toBe("fb")
  })
  it("default passes through when input is non-empty", async () => {
    expect(await render(`{{ .x | default "fb" }}`, { x: "kept" })).toBe("kept")
  })
  it("printf %q quotes a string Go-style", async () => {
    expect(await render(`{{ "hello" | printf "%q" }}`, {})).toBe(`"hello"`)
  })
  it("printf %s and %d formatting via head call", async () => {
    expect(await render(`{{ printf "%s=%d" "n" 7 }}`, {})).toBe("n=7")
  })
  it("unknown function passes input through unchanged", async () => {
    expect(await render(`{{ "abc" | mystery }}`, {})).toBe("abc")
  })
  it("$value | printf %q matches Go behavior inside range over a map", async () => {
    const out = await render(
      `{{- range $k, $v := .m }}{{ $k }}={{ $v | printf "%q" }}\n{{ end -}}`,
      { m: { a: "one", b: "two" } },
    )
    expect(out).toBe(`a="one"\nb="two"\n`)
  })
})

// ---------------------------------------------------------------------------
// Nested scope: range-in-range-in-if
// ---------------------------------------------------------------------------

describe("renderGoTemplate: dot-rebinding range", () => {
  it("binds {{ . }} to the current item for primitive arrays", async () => {
    const out = await render(`{{- range .arr }}{{ . }}.{{ end -}}`, {
      arr: ["a", "b", "c"],
    })
    expect(out).toBe("a.b.c.")
  })
  it("binds .field to the current item for object arrays", async () => {
    const out = await render(`{{- range .arr }}{{ .name }}-{{ end -}}`, {
      arr: [{ name: "x" }, { name: "y" }],
    })
    expect(out).toBe("x-y-")
  })
})

describe("renderGoTemplate: nested scope shadowing", () => {
  it("inner $value binds to inner iteration; outer is preserved on exit", async () => {
    const tpl = `{{- if .enabled }}{{ range $g, $vs := .groups }}group={{ $g }};{{ range $value := $vs }}item={{ $value }};{{ end }}back={{ $g }}|{{ end }}{{ end -}}`
    const out = await render(tpl, {
      enabled: true,
      groups: { x: ["one", "two"], y: ["three"] },
    })
    expect(out).toBe(
      "group=x;item=one;item=two;back=x|group=y;item=three;back=y|",
    )
  })
  it("range-in-range over object map: inner $value access shadows outer", async () => {
    const tpl = `{{- range $outerK, $outerV := .data }}OUTER:{{ $outerK }}{{ range $innerK, $value := $outerV }}/{{ $innerK }}={{ $value }}{{ end }};{{ end -}}`
    const out = await render(tpl, {
      data: {
        a: { x: "1", y: "2" },
        b: { z: "3" },
      },
    })
    expect(out).toBe("OUTER:a/x=1/y=2;OUTER:b/z=3;")
  })
})

