import { describe, expect, expectTypeOf, it } from "bun:test"
import { Schema } from "effect"
import { ConfigError } from "./configError.ts"
import { ContentHash, type ParseResult, RunbookDocument } from "./document.ts"

const hash = (c: string) => `sha256:${c.repeat(64)}`
const span = { start: { line: 3, column: 1 }, end: { line: 3, column: 40 } }

const encoded = {
  file: "/runbooks/demo/runbook.mdx",
  frontMatter: { runbooks: ">= 0.31" },
  tree: {
    type: "root",
    children: [
      { type: "heading", depth: 1, children: [{ type: "text", value: "Demo" }] },
      { type: "block", index: 0, children: [] },
    ],
  },
  blocks: [
    {
      index: 0,
      tag: "Command",
      block: "Command",
      class: "task",
      id: "hello",
      idAsWritten: "hello",
      props: { command: "echo hi" },
      shared: { dependsOn: ["setup"], envFrom: ["aws"] },
      span,
    },
  ],
  edges: [
    {
      from: "hello",
      to: "aws",
      source: { _tag: "Prop", prop: "envFrom", capability: "env" },
      file: "/runbooks/demo/runbook.mdx",
      span,
    },
  ],
  hash: { runbook: hash("a"), files: { "scripts/hello.sh": hash("b") }, combined: hash("c") },
  warnings: [],
}

describe("RunbookDocument", () => {
  it("decodes a document with a block, an edge and file hashes", () => {
    const doc = Schema.decodeUnknownSync(RunbookDocument)(encoded)
    expect(doc.blocks[0]?.shared.envFrom?.map(String)).toEqual(["aws"])
    expect(doc.edges[0]?.source).toEqual({ _tag: "Prop", prop: "envFrom", capability: "env" })
    expect(doc.tree.children?.[1]).toEqual({ type: "block", index: 0, children: [] })
  })

  it("rejects a hash that is not sha256 hex", () => {
    expect(() => Schema.decodeUnknownSync(ContentHash)("md5:abc")).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(RunbookDocument)({
        ...encoded,
        hash: { ...encoded.hash, combined: "sha256:XYZ" },
      }),
    ).toThrow()
  })

  it("rejects a reference to a capability that does not exist", () => {
    const edges = [
      { ...encoded.edges[0], source: { _tag: "Prop", prop: "x", capability: "admin" } },
    ]
    expect(() => Schema.decodeUnknownSync(RunbookDocument)({ ...encoded, edges })).toThrow()
  })
})

describe("Edge", () => {
  it("says whether a template read is behind a guard", () => {
    const edges = [
      { ...encoded.edges[0], source: { _tag: "Template", key: "org_id", guarded: true } },
    ]
    const doc = Schema.decodeUnknownSync(RunbookDocument)({ ...encoded, edges })
    expect(doc.edges[0]?.source).toEqual({ _tag: "Template", key: "org_id", guarded: true })
    const unsaid = [{ ...encoded.edges[0], source: { _tag: "Template", key: "org_id" } }]
    expect(() => Schema.decodeUnknownSync(RunbookDocument)({ ...encoded, edges: unsaid })).toThrow()
  })
})

describe("ConfigError", () => {
  it("carries the location as fields", () => {
    const error = new ConfigError({
      code: "missingReference",
      message: 'envFrom names "aws-auth", and no block has that id',
      location: {
        file: "runbook.mdx",
        span,
        block: { tag: "Command", id: "hello" },
        prop: "envFrom",
      },
      expected: "the id of a block that provides env",
      received: "aws-auth",
      suggestion: "aws_auth",
    })
    expect(error._tag).toBe("ConfigError")
    expect(error.location.span.start.line).toBe(3)
    expect(error.location.prop).toBe("envFrom")
  })

  it("rejects a line before the first", () => {
    const Encoded = Schema.toEncoded(ConfigError)
    expect(() =>
      Schema.decodeUnknownSync(Encoded)({
        _tag: "ConfigError",
        code: "syntax",
        message: "x",
        location: {
          file: "f",
          span: { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } },
        },
      }),
    ).toThrow()
  })
})

describe("ParseResult", () => {
  it("cannot be Invalid with no errors", () => {
    type Invalid = Extract<ParseResult, { _tag: "Invalid" }>
    expectTypeOf<{ _tag: "Invalid"; errors: readonly []; warnings: [] }>().not.toExtend<Invalid>()
  })
})
