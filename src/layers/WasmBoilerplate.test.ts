import { describe, it, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { WasmBoilerplateLive } from "./WasmBoilerplate.ts"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"

/**
 * Helper: build a layer that wires WasmBoilerplateLive on top of an in-memory
 * test file system pre-populated with `files`. Returns the composed layer plus
 * a reference to the same `files` map so tests can read back what was written.
 *
 * Note: the test fs's `writeFile` mutates the passed `files` object in place,
 * so checking `files["/out/foo.txt"]` after running the Effect reflects writes.
 */
function makeLayer(files: Record<string, string>) {
  const fsLayer = makeTestFileSystem(files)
  const boilerplateLayer = Layer.provide(WasmBoilerplateLive, fsLayer)
  return Layer.mergeAll(fsLayer, boilerplateLayer)
}

/** Convenience: invoke renderer.renderTemplate and unwrap. */
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

/** Same as runRender but returns the Exit so we can assert failures. */
function runRenderExit(
  files: Record<string, string>,
  templateDir: string,
  outputDir: string,
  variables: Record<string, unknown>,
) {
  const layer = makeLayer(files)
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const renderer = yield* BoilerplateRenderer
      yield* renderer.renderTemplate(templateDir, outputDir, variables)
    }).pipe(Effect.provide(layer)),
  )
}

describe("WasmBoilerplate.renderTemplate", () => {
  it("produces no output files when template only contains boilerplate.yml", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    // No file should have been written under /out.
    const outputs = Object.keys(files).filter((k) => k.startsWith("/out/"))
    expect(outputs).toEqual([])
  })

  it("copies a single plain file to output with content unchanged", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/hello.txt": "hello world",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    expect(files["/out/hello.txt"]).toBe("hello world")
  })

  it("renders a templated filename to the correct on-disk name", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/{{ .inputs.Name }}": "// generated\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { Name: "foo.hcl" },
      outputs: {},
    })

    expect(files["/out/foo.hcl"]).toBe("// generated\n")
    // The literal templated path should not exist.
    expect(files["/out/{{ .inputs.Name }}"]).toBeUndefined()
  })

  it("renders nested templated directory and file names", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/{{ .inputs.Region }}/{{ .inputs.Account }}/main.tf":
        "region = \"{{ .inputs.Region }}\"\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { Region: "us-east-1", Account: "prod" },
      outputs: {},
    })

    expect(files["/out/us-east-1/prod/main.tf"]).toBe("region = \"us-east-1\"\n")
  })

  it("skips boilerplate.yml and boilerplate.yaml at every nesting level", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "root config\n",
      "/tpl/sub/boilerplate.yaml": "nested config\n",
      "/tpl/sub/keep.txt": "kept\n",
      "/tpl/sub/deep/boilerplate.yml": "deeper config\n",
      "/tpl/sub/deep/keep.txt": "deep kept\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    // Configs must NOT appear in output.
    expect(files["/out/boilerplate.yml"]).toBeUndefined()
    expect(files["/out/sub/boilerplate.yaml"]).toBeUndefined()
    expect(files["/out/sub/deep/boilerplate.yml"]).toBeUndefined()

    // Sibling files must be preserved.
    expect(files["/out/sub/keep.txt"]).toBe("kept\n")
    expect(files["/out/sub/deep/keep.txt"]).toBe("deep kept\n")
  })

  it("rejects scope escapes via path traversal in templated segments", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/{{ .inputs.Bad }}/secret.txt": "uh oh\n",
    }

    const exit = await runRenderExit(files, "/tpl", "/out", {
      inputs: { Bad: "../../etc/passwd" },
      outputs: {},
    })

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const message = JSON.stringify(exit.cause)
      expect(message).toContain("RenderError")
      expect(message).toMatch(/outside output directory/i)
    }

    // Ensure nothing was written to the escape target.
    expect(files["/etc/passwd"]).toBeUndefined()
  })

  it("renders bare-dot range over a plain object map (no fromJson wrapper)", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/map.txt":
        "{{- range $k, $v := .inputs.Map }}{{ $k }}={{ $v }}\n{{ end -}}",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { Map: { a: 1, b: 2 } },
      outputs: {},
    })

    expect(files["/out/map.txt"]).toBe("a=1\nb=2\n")
  })

  it("still supports the legacy (fromJson .path) range form", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/map.txt":
        "{{- range $k, $v := (fromJson .inputs.Map) }}{{ $k }}={{ $v }}\n{{ end -}}",
    }

    await runRender(files, "/tpl", "/out", {
      // Legacy form: value is a JSON string that fromJson must parse.
      inputs: { Map: '{"a":1,"b":2}' },
      outputs: {},
    })

    expect(files["/out/map.txt"]).toBe("a=1\nb=2\n")
  })

  it("skips a file whose templated name renders to the empty string", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/{{ .inputs.Maybe }}": "should not appear\n",
      "/tpl/keep.txt": "kept\n",
    }

    await runRender(files, "/tpl", "/out", {
      inputs: { Maybe: "" }, // resolves to "", so segment is empty -> skip
      outputs: {},
    })

    // Empty rendered segment means skip this entry entirely.
    const outKeys = Object.keys(files).filter((k) => k.startsWith("/out/"))
    expect(outKeys.sort()).toEqual(["/out/keep.txt"])
  })

  it("writes deep nested content even when intermediate dirs do not exist yet", async () => {
    const files: Record<string, string> = {
      "/tpl/boilerplate.yml": "variables: []\n",
      "/tpl/a/b/c/d/file.txt": "deep\n",
    }

    await runRender(files, "/tpl", "/out", { inputs: {}, outputs: {} })

    expect(files["/out/a/b/c/d/file.txt"]).toBe("deep\n")
  })
})

describe("WasmBoilerplate.renderFile (regression)", () => {
  // Sanity-check that the existing renderFile behavior still works after the
  // range-regex extension. These mirror the simplest cases the IPC handler
  // exercises.
  it("renders dot-path substitution unchanged", async () => {
    const files: Record<string, string> = {}
    const layer = makeLayer(files)
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* BoilerplateRenderer
        return yield* renderer.renderFile("hello {{ .inputs.Name }}", {
          inputs: { Name: "world" },
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(out).toBe("hello world")
  })

  it("renders fromJson + range over a JSON-string still works", async () => {
    const files: Record<string, string> = {}
    const layer = makeLayer(files)
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* BoilerplateRenderer
        return yield* renderer.renderFile(
          "{{- range $v := (fromJson .inputs.Items) }}-{{ $v }}\n{{ end -}}",
          { inputs: { Items: '["x","y"]' } },
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(out).toBe("-x\n-y\n")
  })
})
