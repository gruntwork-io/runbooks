import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { WasmBoilerplateLive } from "./WasmBoilerplate.ts"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"

/**
 * Tests for `skip_files` integration in `renderTemplate`.
 *
 * The walker reads `<templateDir>/boilerplate.yml` (or `.yaml`) at the start
 * of the render, parses the `skip_files:` block, and drops any file whose
 * raw (pre-render) relative path matches an entry — optionally conditioned
 * on an `if:` Go-template expression that must evaluate truthy.
 */

function makeLayer(files: Record<string, string>) {
  const fsLayer = makeTestFileSystem(files)
  const boilerplateLayer = Layer.provide(WasmBoilerplateLive, fsLayer)
  return Layer.mergeAll(fsLayer, boilerplateLayer)
}

function runRender(
  files: Record<string, string>,
  templateDir: string,
  outputDir: string,
  variables: Record<string, unknown>,
) {
  const layer = makeLayer(files)
  return Effect.runPromise(
    Effect.gen(function* () {
      const renderer = yield* BoilerplateRenderer
      yield* renderer.renderTemplate(templateDir, outputDir, variables)
    }).pipe(Effect.provide(layer)),
  )
}

describe("WasmBoilerplate.renderTemplate — skip_files", () => {
  // Monkey-patch console.warn to capture warnings without polluting test
  // output. Each test that cares inspects `warnings`; others ignore it.
  let warnings: string[]
  let originalWarn: typeof console.warn

  beforeEach(() => {
    warnings = []
    originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  it("skips a file when the `if` condition evaluates truthy", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        'variables: []\nskip_files:\n  - path: a.txt\n    if: "{{ eq .inputs.mode \\"prod\\" }}"\n',
      "/tpl/a.txt": "a content\n",
      "/tpl/b.txt": "b content\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { mode: "prod" },
      outputs: {},
    })

    // prod mode → a.txt is skipped, only b.txt remains.
    const outKeys = Object.keys(files).filter((k) => k.startsWith("/out/"))
    expect(outKeys.sort()).toEqual(["/out/b.txt"])
    expect(files["/out/b.txt"]).toBe("b content\n")
    expect(files["/out/a.txt"]).toBeUndefined()
  })

  it("keeps a file when the `if` condition evaluates falsy", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        'variables: []\nskip_files:\n  - path: a.txt\n    if: "{{ eq .inputs.mode \\"prod\\" }}"\n',
      "/tpl/a.txt": "a content\n",
      "/tpl/b.txt": "b content\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { mode: "dev" },
      outputs: {},
    })

    const outKeys = Object.keys(files).filter((k) => k.startsWith("/out/"))
    expect(outKeys.sort()).toEqual(["/out/a.txt", "/out/b.txt"])
  })

  it("treats empty-string `if` output as falsy (keeps the file)", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        'variables: []\nskip_files:\n  - path: a.txt\n    if: "{{ .inputs.neverSet }}"\n',
      "/tpl/a.txt": "a content\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: {},
      outputs: {},
    })

    // inputs.neverSet is undefined → renders to empty string → falsy → keep.
    expect(files["/out/a.txt"]).toBe("a content\n")
  })

  it("treats literal \"false\" and \"0\" `if` output as falsy (keeps the file)", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        'variables: []\nskip_files:\n  - path: a.txt\n    if: "false"\n  - path: b.txt\n    if: "0"\n',
      "/tpl/a.txt": "a\n",
      "/tpl/b.txt": "b\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    expect(files["/out/a.txt"]).toBe("a\n")
    expect(files["/out/b.txt"]).toBe("b\n")
  })

  it("always skips when no `if` is present", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        "variables: []\nskip_files:\n  - path: a.txt\n",
      "/tpl/a.txt": "never\n",
      "/tpl/b.txt": "kept\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    expect(files["/out/a.txt"]).toBeUndefined()
    expect(files["/out/b.txt"]).toBe("kept\n")
  })

  it("logs a warning and keeps the file when `if` uses an unknown function", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        'variables: []\nskip_files:\n  - path: a.txt\n    if: "{{ badFunction .x }}"\n',
      "/tpl/a.txt": "kept\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { x: "value" },
      outputs: {},
    })

    // Unrenderable expressions are fail-safe: keep the file.
    expect(files["/out/a.txt"]).toBe("kept\n")
    expect(
      warnings.some((w) => w.includes("skip_files") && w.includes("a.txt")),
    ).toBe(true)
    expect(warnings.some((w) => w.includes("badFunction"))).toBe(true)
  })

  it("treats a bare-string `if` as a bare template expression (keeps when unknown)", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        // A bare expression (no `{{ }}`) is auto-wrapped. Garbage identifiers
        // inside it trip the strict-unknown-function check → warn + keep.
        "variables: []\nskip_files:\n  - path: a.txt\n    if: \"plain truthy literal\"\n",
      "/tpl/a.txt": "kept\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { x: "value" },
      outputs: {},
    })

    expect(files["/out/a.txt"]).toBe("kept\n")
    expect(warnings.some((w) => w.includes("skip_files"))).toBe(true)
  })

  it("supports boilerplate.yaml (not just .yml) for the config", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yaml":
        "variables: []\nskip_files:\n  - path: a.txt\n",
      "/tpl/a.txt": "never\n",
      "/tpl/b.txt": "kept\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    expect(files["/out/a.txt"]).toBeUndefined()
    expect(files["/out/b.txt"]).toBe("kept\n")
  })

  it("matches skip_files path against the raw (pre-render) source path", async () => {
    // A file whose filename is a Go-template expression should match against
    // its raw name in skip_files, not the rendered output name. This mirrors
    // how upstream Go boilerplate matches paths during the walk.
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml":
        "variables: []\nskip_files:\n  - path: sub/{{ .inputs.Name }}.txt\n",
      "/tpl/sub/{{ .inputs.Name }}.txt": "secret\n",
      "/tpl/sub/keep.txt": "kept\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { Name: "foo" },
      outputs: {},
    })

    // The templated file should be skipped; sibling untouched.
    expect(files["/out/sub/foo.txt"]).toBeUndefined()
    expect(files["/out/sub/keep.txt"]).toBe("kept\n")
  })

  it("noop when the template has no boilerplate config at all", async () => {
    const files: Record<string, string> = {
      "/tpl/a.txt": "a\n",
      "/tpl/b.txt": "b\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    // No config → empty skipFiles → both files written.
    expect(files["/out/a.txt"]).toBe("a\n")
    expect(files["/out/b.txt"]).toBe("b\n")
  })
})
