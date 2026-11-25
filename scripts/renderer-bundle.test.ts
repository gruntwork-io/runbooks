/**
 * Can the renderer carry Effect Schema? The window will import the engine
 * protocol and decode every event with it. This bundles exactly that for
 * the browser with Vite, as the renderer build does, and checks that the
 * result needs nothing from Node, never evaluates code (so the app's CSP
 * can drop 'unsafe-eval'), runs, and stays within a size budget.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { build, type Rollup } from "vite"

const ROOT = path.resolve(import.meta.dir, "..")
const PROTOCOL = path.join(ROOT, "packages/core/src/engine/protocol.ts")
/** What the window will import: the protocol, and Schema to decode with it. */
const ENTRY_ID = "renderer-bundle-entry"

/**
 * Gzipped bytes the bundle may reach. Measured at 36,655 on 2026-11-24 with
 * Effect 4.1.2 and Vite 8.3.6, against 1,414,781 for all of today's renderer
 * JavaScript. The budget leaves about a third for growth, so a change that
 * pulls in much more of Effect fails here.
 */
const MAX_GZIP_BYTES = 48 * 1024

let dir: string
let chunk: Rollup.OutputChunk

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "renderer-bundle-"))
  const entry = [
    `import { Schema } from "effect"`,
    `import { EventEnvelope } from ${JSON.stringify(PROTOCOL)}`,
    `export const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(EventEnvelope))`,
  ].join("\n")
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: ROOT,
    plugins: [
      {
        name: "renderer-bundle-entry",
        resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : undefined),
        load: (id) => (id === `\0${ENTRY_ID}` ? entry : undefined),
      },
    ],
    build: {
      write: false,
      minify: true,
      target: "es2022",
      rollupOptions: {
        input: ENTRY_ID,
        preserveEntrySignatures: "strict",
        output: { format: "es" },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    "output" in r ? r.output : [],
  )
  const chunks = outputs.filter((o): o is Rollup.OutputChunk => o.type === "chunk")
  expect(chunks).toHaveLength(1)
  chunk = chunks[0]!
  writeFileSync(path.join(dir, "bundle.mjs"), chunk.code)
}, 60_000)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("the renderer bundle of Effect Schema and the engine protocol", () => {
  it("imports nothing, from Node or anywhere else", () => {
    expect(chunk.imports).toEqual([])
    expect(chunk.dynamicImports).toEqual([])
  })

  it("has no eval or Function call in its source", () => {
    expect(chunk.code).not.toMatch(/(?<![\w$.])eval\(/)
    expect(chunk.code).not.toMatch(/(?<![\w$.])Function\(/)
  })

  it("runs, and decodes an event as the window will, with eval and Function trapped", async () => {
    // What a CSP without 'unsafe-eval' does: any attempt to evaluate a string
    // throws. `eval` is swapped through Reflect because the test replaces it,
    // never calls it, and no-eval flags any reference to the name.
    const realEval: unknown = Reflect.get(globalThis, "eval")
    const realFunction = globalThis.Function
    const refuse = () => {
      throw new EvalError("refused by the test's CSP stand-in")
    }
    Reflect.set(globalThis, "eval", refuse)
    globalThis.Function = new Proxy(realFunction, { apply: refuse, construct: refuse })
    try {
      const { decodeEvent } = (await import(path.join(dir, "bundle.mjs"))) as {
        decodeEvent: (input: unknown) => { sequence: number; event: { _tag: string } }
      }
      const event = decodeEvent({
        session: "s1",
        sequence: 7,
        at: "2026-11-24T12:00:00.000Z",
        event: { _tag: "OutputsWithdrawn", block: "greet" },
      })
      expect([event.sequence, event.event._tag]).toEqual([7, "OutputsWithdrawn"])
      expect(() => decodeEvent({ session: "s1", sequence: -1, at: "x", event: {} })).toThrow(
        /sequence/,
      )
    } finally {
      Reflect.set(globalThis, "eval", realEval)
      globalThis.Function = realFunction
    }
  })

  it(`stays under ${MAX_GZIP_BYTES} gzipped bytes`, () => {
    const gzipped = gzipSync(chunk.code).length
    console.log(`renderer bundle: ${chunk.code.length} bytes minified, ${gzipped} gzipped`)
    expect(gzipped).toBeLessThan(MAX_GZIP_BYTES)
  })
})
