/**
 * Reading `$RUNBOOK_OUTPUT` and `$RUNBOOK_ENV` (work product 2.5). The tests
 * named as in today's src/domain/exec/script.test.ts are ported from its
 * `parseBlockOutputs` tests. Today's parser skipped a line it could not
 * read; this one rejects it, naming the line, so the tests that said
 * "skips" say "rejects".
 */
import { describe, expect, it } from "bun:test"
import { inspect } from "node:util"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import { FileSystem } from "../services/FileSystem.ts"
import { FileWriteError } from "../errors/index.ts"
import { makeTestFileSystem, testFileSystem } from "../test-utils/TestFileSystem.ts"
import { LIMITS } from "./protocol.ts"
import {
  copyGenerated,
  parseRunFile,
  RUN_FILE_LIMITS,
  type RunFile,
  type RunFiles,
  readRunFiles,
  runFilesFailed,
} from "./runFiles.ts"

/** Each name's value, revealed, and whether a line marked it. */
const parse = (text: string, file: RunFile = "RUNBOOK_OUTPUT") => {
  const { written, problems } = parseRunFile(file, text)
  return {
    written: Object.fromEntries(
      Array.from(written, ([name, { value, marked }]) => [
        name,
        { value: Redacted.value(value), marked },
      ]),
    ),
    problems,
  }
}

/** The values alone, for a file with no problem. */
const values = (text: string, file: RunFile = "RUNBOOK_OUTPUT") => {
  const { written, problems } = parse(text, file)
  expect(problems).toEqual([])
  return Object.fromEntries(Object.entries(written).map(([name, { value }]) => [name, value]))
}

/** The lines `text` has problems at, and what each is. */
const problemsIn = (text: string, file: RunFile = "RUNBOOK_OUTPUT") =>
  parse(text, file).problems.map(({ line, problem }) => [line, problem._tag])

const FILES: RunFiles = {
  RUNBOOK_OUTPUT: "/run/output",
  RUNBOOK_ENV: "/run/env",
  GENERATED_FILES: "/run/files",
}

/** What `readRunFiles` makes of `files`, its outputs revealed. */
const readFrom = (files: Record<string, string>) =>
  Effect.runPromise(
    Effect.result(
      readRunFiles(FILES).pipe(
        Effect.map(({ outputs, env }) => ({
          outputs: Object.fromEntries(
            Array.from(outputs, ([name, { value }]) => [name, Redacted.value(value)]),
          ),
          env: Object.fromEntries(
            Array.from(env, ([name, value]) => [name, Redacted.value(value)]),
          ),
        })),
        Effect.provide(makeTestFileSystem(files)),
      ),
    ),
  )

describe("parseBlockOutputs", () => {
  it("parses key=value pairs", async () => {
    expect(
      await readFrom({ [FILES.RUNBOOK_OUTPUT]: "CLUSTER_NAME=my-cluster\nREGION=us-east-1\n" }),
    ).toEqual(
      Result.succeed({ outputs: { CLUSTER_NAME: "my-cluster", REGION: "us-east-1" }, env: {} }),
    )
  })

  it("preserves leading whitespace in values (trailing stripped by line trim)", () => {
    expect(values("MSG= hello world \n")).toEqual({ MSG: " hello world" })
  })

  it("rejects invalid keys, naming each line", () => {
    expect(problemsIn("VALID=yes\n123INVALID=no\n-bad=no\n")).toEqual([
      [2, "NotAName"],
      [3, "NotAName"],
    ])
  })

  it("rejects lines without an equals sign, naming each line", () => {
    expect(problemsIn("GOOD=val\nno-equals-here\n")).toEqual([[2, "NotNameValue"]])
  })

  it("returns empty object for missing file", async () => {
    expect(await readFrom({})).toEqual(Result.succeed({ outputs: {}, env: {} }))
  })

  it("returns empty object for empty file", async () => {
    expect(await readFrom({ [FILES.RUNBOOK_OUTPUT]: "", [FILES.RUNBOOK_ENV]: "" })).toEqual(
      Result.succeed({ outputs: {}, env: {} }),
    )
  })

  it("handles values containing equals signs", () => {
    expect(values("CONFIG=key=value=extra\n")).toEqual({ CONFIG: "key=value=extra" })
  })

  it("accepts underscore-prefixed keys", () => {
    expect(values("_PRIVATE=yes\n__DOUBLE=also\n")).toEqual({ _PRIVATE: "yes", __DOUBLE: "also" })
  })

  it("wraps a value the sensitive: prefix marks", () => {
    expect(
      parse("AWS_REGION=us-west-2\nsensitive:AWS_SECRET_ACCESS_KEY=abc/123\n").written,
    ).toEqual({
      AWS_REGION: { value: "us-west-2", marked: false },
      AWS_SECRET_ACCESS_KEY: { value: "abc/123", marked: true },
    })
  })
})

describe("parseBlockOutputsContent", () => {
  it("keeps value whitespace and rejects invalid or empty keys", () => {
    const { written, problems } = parse("MSG= hi\n=no-key\nbad-key=x\nOK=1\n")
    expect(Object.keys(written)).toEqual(["MSG", "OK"])
    expect(written["MSG"]?.value).toBe(" hi")
    expect(problems.map(({ line }) => line)).toEqual([2, 3])
  })

  describe("sensitive: prefix", () => {
    it("stores the value under the plain key, wrapped as sensitive", () => {
      const { written } = parseRunFile("RUNBOOK_OUTPUT", "sensitive:TOKEN=s3cr3t\nUSER=alice\n")
      expect(Array.from(written.keys())).toEqual(["TOKEN", "USER"])
      expect(written.get("TOKEN")?.marked).toBe(true)
      expect(Redacted.value(written.get("TOKEN")!.value)).toBe("s3cr3t")
      expect(written.get("USER")?.marked).toBe(false)
    })

    it("never shows the value when the parsed outputs are printed", () => {
      const parsed = parseRunFile("RUNBOOK_OUTPUT", "sensitive:TOKEN=s3cr3t\nUSER=alice\n")
      const printed = [
        inspect(parsed.written.get("TOKEN")?.value),
        JSON.stringify(Object.fromEntries(parsed.written)),
        inspect(parsed, { depth: 10 }),
      ]
      for (const text of printed) expect(text).not.toContain("s3cr3t")
    })

    it("trims whitespace between the prefix and the key", () => {
      expect(parse("sensitive: TOKEN =s3cr3t\n").written).toEqual({
        TOKEN: { value: "s3cr3t", marked: true },
      })
    })

    it("keeps the value's leading whitespace, as for a plain key", () => {
      expect(parse("sensitive:TOKEN= s3cr3t\n").written).toEqual({
        TOKEN: { value: " s3cr3t", marked: true },
      })
    })

    it("rejects an invalid or empty key after the prefix", () => {
      expect(problemsIn("sensitive:bad-key=x\nsensitive:=y\nsensitive:1ABC=z\n")).toEqual([
        [1, "NotAName"],
        [2, "NotAName"],
        [3, "NotAName"],
      ])
    })

    it("recognises only the exact lowercase prefix", () => {
      expect(problemsIn("SENSITIVE:K=v\nSensitive:J=w\n")).toEqual([
        [1, "NotAName"],
        [2, "NotAName"],
      ])
    })

    it("doesn't treat sensitive: inside a value as a marker", () => {
      expect(parse("NOTE=sensitive:TOKEN=x\n").written).toEqual({
        NOTE: { value: "sensitive:TOKEN=x", marked: false },
      })
    })

    it("keeps a key sensitive when a later plain line rewrites it", () => {
      expect(parse("sensitive:T=a\nT=b\n").written).toEqual({ T: { value: "b", marked: true } })
    })

    it("marks a key sensitive when a later line adds the prefix", () => {
      expect(parse("T=a\nsensitive:T=b\n").written).toEqual({ T: { value: "b", marked: true } })
    })
  })
})

describe("a value with newlines", () => {
  it("is NAME<<DELIMITER, its lines as written, then the delimiter on a line of its own", () => {
    const text = [
      "MULTILINE_KEY<<END_OF_VALUE",
      "-----BEGIN EXAMPLE KEY-----",
      "line1-of-key-content",
      "-----END EXAMPLE KEY-----",
      "END_OF_VALUE",
      "JSON_CONFIG<<END_OF_VALUE",
      "{",
      '  "database": "postgres"',
      "}",
      "END_OF_VALUE",
      "AFTER=1",
      "",
    ].join("\n")
    expect(values(text, "RUNBOOK_ENV")).toEqual({
      MULTILINE_KEY: "-----BEGIN EXAMPLE KEY-----\nline1-of-key-content\n-----END EXAMPLE KEY-----",
      JSON_CONFIG: '{\n  "database": "postgres"\n}',
      AFTER: "1",
    })
  })

  it("reads a line ending in \\r\\n as if it ended in \\n", () => {
    expect(values("A=1\r\nB<<EOF\r\nx\r\ny\r\nEOF\r\n")).toEqual({ A: "1", B: "x\ny" })
  })

  it("reads NAME=a<<b as a value, since = comes first", () => {
    expect(values("CMD=cat <<EOF\n")).toEqual({ CMD: "cat <<EOF" })
  })

  it("is rejected at the line it starts on when no line ends it, and so is the rest", () => {
    expect(problemsIn("A=1\nKEY<<EOF\nsecret\nB=2\n")).toEqual([[2, "Unterminated"]])
    expect(problemsIn("KEY<<\n")).toEqual([[1, "NoDelimiter"]])
  })
})

describe("$RUNBOOK_ENV", () => {
  it("refuses a name Runbooks sets for every run, naming it", () => {
    const { problems } = parse("RUNBOOK_OUTPUT=/elsewhere\nOK=1\nREPO_FILES=/x\n", "RUNBOOK_ENV")
    expect(problems.map(({ line, problem }) => [line, problem])).toEqual([
      [1, { _tag: "Reserved", name: "RUNBOOK_OUTPUT" }],
      [3, { _tag: "Reserved", name: "REPO_FILES" }],
    ])
    // An output may have any name a shell can export.
    expect(values("RUNBOOK_OUTPUT=x\n")).toEqual({ RUNBOOK_OUTPUT: "x" })
  })

  it("refuses a NUL in a variable's value, which an output may hold", () => {
    expect(problemsIn("A=x\0y\n", "RUNBOOK_ENV")).toEqual([[1, "NulInValue"]])
    expect(values("A=x\0y\n")).toEqual({ A: "x\0y" })
  })

  it("may set PATH", () => {
    expect(values("PATH=/work/bin:/usr/bin\n", "RUNBOOK_ENV")).toEqual({
      PATH: "/work/bin:/usr/bin",
    })
  })
})

describe("the bounds", () => {
  it("reads none of a file larger than its byte limit", async () => {
    const big = `A=${"x".repeat(RUN_FILE_LIMITS.bytes)}\n`
    const result = await readFrom({ [FILES.RUNBOOK_ENV]: big })
    expect(Result.isFailure(result) && result.failure.message).toContain(
      `$RUNBOOK_ENV: it is larger than ${RUN_FILE_LIMITS.bytes} bytes, so none of it was read.`,
    )
  })

  it("reads none of a file with more lines than its limit, and all of one at it", () => {
    const lines = (count: number) => "A=1\n".repeat(count)
    expect(problemsIn(lines(RUN_FILE_LIMITS.lines))).toEqual([])
    expect(problemsIn(lines(RUN_FILE_LIMITS.lines + 1))).toEqual([[undefined, "TooManyLines"]])
    expect(parse(lines(RUN_FILE_LIMITS.lines + 1)).written).toEqual({})
  })

  // Linux's execve refuses an environment string past MAX_ARG_STRLEN, 32
  // pages of 4 KiB: 131072 bytes of `NAME=value` and its NUL together.
  const MAX_ARG_STRLEN = 128 * 1024

  it("refuses a variable a process cannot take, counting the bytes of NAME=value and its NUL", () => {
    const at = (name: string, value: string) => `${name}=${value}\n`
    // "A=" and the NUL are 3 bytes; "€" is 3 bytes in UTF-8, and one UTF-16 unit.
    const euros = "€".repeat((MAX_ARG_STRLEN - 3 - 2) / 3) + "xx"
    expect(problemsIn(at("A", euros), "RUNBOOK_ENV")).toEqual([])
    expect(problemsIn(at("A", `${euros}x`), "RUNBOOK_ENV")).toEqual([[1, "VariableTooLong"]])
    // "😀" is 4 bytes, and two UTF-16 units.
    const faces = "😀".repeat((MAX_ARG_STRLEN - 3 - 1) / 4) + "x"
    expect(problemsIn(at("A", faces), "RUNBOOK_ENV")).toEqual([])
    expect(problemsIn(at("A", `${faces}x`), "RUNBOOK_ENV")).toEqual([[1, "VariableTooLong"]])
    // The name counts too.
    const name = "A_LONGER_NAME"
    const ascii = "v".repeat(MAX_ARG_STRLEN - name.length - 2)
    expect(problemsIn(at(name, ascii), "RUNBOOK_ENV")).toEqual([])
    expect(problemsIn(at(name, `${ascii}v`), "RUNBOOK_ENV")).toEqual([[1, "VariableTooLong"]])
  })

  it("refuses an output's value past 128 KiB, counting its bytes", () => {
    const value = "€".repeat((128 * 1024 - 2) / 3) + "xx"
    expect(problemsIn(`A=${value}\n`)).toEqual([])
    expect(problemsIn(`A=${value}x\n`)).toEqual([[1, "ValueTooLong"]])
  })

  it("refuses a name or a value past its length, and takes one at it", () => {
    const name = "N".repeat(RUN_FILE_LIMITS.nameLength)
    const value = "v".repeat(RUN_FILE_LIMITS.valueLength)
    expect(problemsIn(`${name}=${value}\n`)).toEqual([])
    expect(problemsIn(`${name}N=v\nA=${value}v\n`)).toEqual([
      [1, "NameTooLong"],
      [2, "ValueTooLong"],
    ])
  })
})

describe("the run's error", () => {
  it("names each file and line, and never what a line held", async () => {
    const result = await readFrom({
      [FILES.RUNBOOK_OUTPUT]: "TOKEN=ok\nsecret-line-one\n",
      [FILES.RUNBOOK_ENV]: "bad-secret-name=secret-value\nK<<EOF\nsecret-in-heredoc\n",
    })
    const message = Result.isFailure(result) ? result.failure.message : ""
    expect(message.split("\n")).toEqual([
      "The script wrote what Runbooks cannot read, so the run failed.",
      "$RUNBOOK_OUTPUT line 2: not NAME=value or NAME<<DELIMITER.",
      "$RUNBOOK_ENV line 1: the name is not a variable name. Use letters, digits and underscores, and don't start with a digit.",
      "$RUNBOOK_ENV line 2: a NAME<<DELIMITER value with no DELIMITER line to end it.",
    ])
    expect(message).not.toContain("secret")
  })

  it("names the first problems and counts the rest", () => {
    const { problems } = parse("x\n".repeat(RUN_FILE_LIMITS.problemsNamed + 3))
    const lines = runFilesFailed(problems).message.split("\n")
    expect(lines).toHaveLength(1 + RUN_FILE_LIMITS.problemsNamed + 1)
    expect(lines.at(-1)).toBe("And 3 more.")
  })

  it("names a variable too large for a process, its size and the limit in bytes, not its value", async () => {
    const result = await readFrom({ [FILES.RUNBOOK_ENV]: `OK=1\nBIG=${"€".repeat(50_000)}\n` })
    const message = Result.isFailure(result) ? result.failure.message : ""
    expect(message).toContain("$RUNBOOK_ENV line 2: BIG is 150005 bytes")
    expect(message).toContain("131072 bytes")
    expect(message).not.toContain("€")
  })
})

describe("the generated files", () => {
  /** Copies `/run/files` into `/gen` on a filesystem of `files`, and what each then holds. */
  const copyFrom = (files: Record<string, string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const copied = yield* copyGenerated("/run/files", "/gen")
        const fs = yield* FileSystem
        const gen = yield* fs.walk("/gen").pipe(
          Stream.mapEffect((entry) =>
            Effect.map(fs.readFile(entry.path), (text) => [entry.relativePath, text] as const),
          ),
          Stream.runCollect,
        )
        return { copied, gen: Object.fromEntries(gen) }
      }).pipe(Effect.provide(makeTestFileSystem(files))),
    )

  it("copies each file, a nested one too, and says which it made and which it replaced", async () => {
    const { copied, gen } = await copyFrom({
      "/run/files/main.tf": "new main",
      "/run/files/modules/vpc/vpc.tf": "vpc",
      "/gen/main.tf": "old main",
      "/gen/kept.tf": "kept",
    })
    expect(copied.links).toEqual([])
    expect([...copied.changes].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "/gen/main.tf", change: "modified" },
      { path: "/gen/modules/vpc/vpc.tf", change: "created" },
    ])
    expect(gen).toEqual({
      "main.tf": "new main",
      "modules/vpc/vpc.tf": "vpc",
      "kept.tf": "kept",
    })
  })

  it("copies nothing and says nothing for a run that left nothing", async () => {
    const { copied, gen } = await copyFrom({ "/gen/kept.tf": "kept" })
    expect(copied).toEqual({ changes: [], truncated: false, links: [] })
    expect(gen).toEqual({ "kept.tf": "kept" })
  })

  it("copies every file and lists the first of them, up to the limit", async () => {
    const files = Object.fromEntries(
      Array.from({ length: LIMITS.maxRunFiles + 1 }, (_, i) => [`/run/files/${i}.txt`, `${i}`]),
    )
    const { copied, gen } = await copyFrom(files)
    expect(copied.changes).toHaveLength(LIMITS.maxRunFiles)
    expect(copied.truncated).toBe(true)
    expect(Object.keys(gen)).toHaveLength(LIMITS.maxRunFiles + 1)
  })

  it("fails a copy that stops part way with what it had copied, which stays copied", async () => {
    const files: Record<string, string> = { "/run/files/a.txt": "a", "/run/files/b.txt": "b" }
    const base = testFileSystem(files)
    const full = Layer.succeed(FileSystem, {
      ...base,
      copyFile: (src: string, dest: string) =>
        dest.endsWith("/b.txt")
          ? Effect.fail(new FileWriteError({ path: dest, cause: "no space left" }))
          : base.copyFile(src, dest),
    })
    const failed = await Effect.runPromise(
      Effect.flip(copyGenerated("/run/files", "/gen")).pipe(Effect.provide(full)),
    )
    expect(failed.failure.message).toBe(
      "Runbooks could not copy b.txt from $GENERATED_FILES into the generated folder.",
    )
    expect(failed.copied.changes).toEqual([{ path: "/gen/a.txt", change: "created" }])
    expect(files["/gen/a.txt"]).toBe("a")
  })
})
