import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { runAssertion, type AssertionContext } from "./assertions.ts"

function makeCtx(outputDir: string, overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    outputDir,
    blockOutputs: new Map(),
    sessionEnv: [],
    timeout: 5_000,
    ...overrides,
  }
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-assertion-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// File assertions
// ---------------------------------------------------------------------------

describe("file_exists / file_not_exists", () => {
  it("passes when the file exists", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "x")
    const r = runAssertion({ type: "file_exists", path: "a.txt" }, makeCtx(tmp))
    expect(r.passed).toBe(true)
  })

  it("fails when the file is missing", () => {
    const r = runAssertion({ type: "file_exists", path: "missing.txt" }, makeCtx(tmp))
    expect(r.passed).toBe(false)
    expect(r.message).toContain("does not exist")
  })

  it("fails when the path is a directory", () => {
    fs.mkdirSync(path.join(tmp, "subdir"))
    const r = runAssertion({ type: "file_exists", path: "subdir" }, makeCtx(tmp))
    expect(r.passed).toBe(false)
  })

  it("file_not_exists passes for missing path, fails when present", () => {
    const r1 = runAssertion({ type: "file_not_exists", path: "missing" }, makeCtx(tmp))
    expect(r1.passed).toBe(true)
    fs.writeFileSync(path.join(tmp, "present.txt"), "x")
    const r2 = runAssertion({ type: "file_not_exists", path: "present.txt" }, makeCtx(tmp))
    expect(r2.passed).toBe(false)
  })
})

describe("dir_exists / dir_not_exists", () => {
  it("dir_exists passes for a directory, fails for a file", () => {
    fs.mkdirSync(path.join(tmp, "sub"))
    expect(
      runAssertion({ type: "dir_exists", path: "sub" }, makeCtx(tmp)).passed,
    ).toBe(true)

    fs.writeFileSync(path.join(tmp, "f"), "")
    expect(
      runAssertion({ type: "dir_exists", path: "f" }, makeCtx(tmp)).passed,
    ).toBe(false)
  })

  it("dir_not_exists passes when absent", () => {
    expect(
      runAssertion({ type: "dir_not_exists", path: "no-such-dir" }, makeCtx(tmp)).passed,
    ).toBe(true)
  })
})

describe("file_contains / file_not_contains", () => {
  it("passes when substring is present", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "hello world")
    expect(
      runAssertion({ type: "file_contains", path: "a.txt", contains: "hello" }, makeCtx(tmp))
        .passed,
    ).toBe(true)
  })

  it("fails with a useful message when substring is missing", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "different")
    const r = runAssertion(
      { type: "file_contains", path: "a.txt", contains: "missing-needle" },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(false)
    expect(r.message).toContain("missing-needle")
  })

  it("file_not_contains passes when substring is absent", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "different")
    expect(
      runAssertion(
        { type: "file_not_contains", path: "a.txt", contains: "missing-needle" },
        makeCtx(tmp),
      ).passed,
    ).toBe(true)
  })
})

describe("file_matches", () => {
  it("passes when regex matches", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "v1.2.3")
    expect(
      runAssertion(
        { type: "file_matches", path: "a.txt", pattern: "^v\\d+\\.\\d+\\.\\d+$" },
        makeCtx(tmp),
      ).passed,
    ).toBe(true)
  })

  it("fails on non-match", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "nope")
    expect(
      runAssertion(
        { type: "file_matches", path: "a.txt", pattern: "^\\d+$" },
        makeCtx(tmp),
      ).passed,
    ).toBe(false)
  })
})

describe("file_equals", () => {
  it("passes on exact match", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "hello\n")
    expect(
      runAssertion({ type: "file_equals", path: "a.txt", value: "hello\n" }, makeCtx(tmp))
        .passed,
    ).toBe(true)
  })

  it("fails on mismatch with descriptive message", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "actual")
    const r = runAssertion(
      { type: "file_equals", path: "a.txt", value: "expected" },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(false)
    expect(r.message).toContain("does not equal")
  })
})

// ---------------------------------------------------------------------------
// Output assertions
// ---------------------------------------------------------------------------

describe("output_equals / output_matches / output_exists", () => {
  function withOutputs(map: Record<string, Record<string, string>>) {
    const outputs = new Map<string, Map<string, string>>()
    for (const [block, kv] of Object.entries(map)) {
      outputs.set(block, new Map(Object.entries(kv)))
    }
    return makeCtx(tmp, { blockOutputs: outputs })
  }

  it("output_equals passes on exact match", () => {
    const ctx = withOutputs({ b1: { region: "us-east-1" } })
    const r = runAssertion(
      { type: "output_equals", block: "b1", output: "region", value: "us-east-1" },
      ctx,
    )
    expect(r.passed).toBe(true)
  })

  it("output_equals fails with the actual vs expected in message", () => {
    const ctx = withOutputs({ b1: { region: "us-west-2" } })
    const r = runAssertion(
      { type: "output_equals", block: "b1", output: "region", value: "us-east-1" },
      ctx,
    )
    expect(r.passed).toBe(false)
    expect(r.message).toContain("us-west-2")
    expect(r.message).toContain("us-east-1")
  })

  it("output_equals fails when block has no outputs", () => {
    const r = runAssertion(
      { type: "output_equals", block: "missing", output: "x", value: "y" },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(false)
  })

  it("output_matches passes when pattern matches", () => {
    const ctx = withOutputs({ b1: { url: "https://example.com/x" } })
    const r = runAssertion(
      { type: "output_matches", block: "b1", output: "url", pattern: "^https://" },
      ctx,
    )
    expect(r.passed).toBe(true)
  })

  it("output_exists passes when output exists, fails otherwise", () => {
    const ctx = withOutputs({ b1: { present: "yes" } })
    expect(
      runAssertion({ type: "output_exists", block: "b1", output: "present" }, ctx).passed,
    ).toBe(true)
    expect(
      runAssertion({ type: "output_exists", block: "b1", output: "absent" }, ctx).passed,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// files_generated
// ---------------------------------------------------------------------------

describe("files_generated", () => {
  it("passes when output dir has >= min_count files", () => {
    fs.writeFileSync(path.join(tmp, "a"), "")
    fs.writeFileSync(path.join(tmp, "b"), "")
    fs.mkdirSync(path.join(tmp, "sub"))
    fs.writeFileSync(path.join(tmp, "sub", "c"), "")
    const r = runAssertion(
      { type: "files_generated", block: "x", min_count: 3 },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(true)
  })

  it("fails with a count comparison when too few", () => {
    const r = runAssertion(
      { type: "files_generated", block: "x", min_count: 5 },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(false)
    expect(r.message).toContain("at least 5")
  })
})

// ---------------------------------------------------------------------------
// script
// ---------------------------------------------------------------------------

describe("script", () => {
  it("passes when the bash command exits 0", () => {
    const r = runAssertion(
      { type: "script", command: "true" },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(true)
  })

  it("fails when the bash command exits non-zero", () => {
    const r = runAssertion(
      { type: "script", command: "exit 7" },
      makeCtx(tmp),
    )
    expect(r.passed).toBe(false)
    expect(r.message).toContain("Script assertion failed")
  })
})
