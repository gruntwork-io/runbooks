/**
 * Decision 8, ruled as recommended: a Command declares the outputs its
 * script writes (`outputs`), and a template that reads an output its block
 * does not declare is a configuration error, so the block that reads it
 * never runs. The engine keeps only the outputs a block declares. No
 * testdata runbook reads an undeclared output, and each key a testdata
 * Command's script writes, as written in it, is one the Command declares.
 *
 * The read check is the new tree's own, through the registry: a block it
 * does not have yet is not checked, nor the reads inside it, until it is
 * added. The write check finds every Command, through the stand-ins for
 * the tags the registry does not have yet (`standIns.ts`).
 */
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import * as registry from "@runbooks/blocks"
import { configErrors } from "@runbooks/core/document/document"
import { loadRunbook } from "@runbooks/core/document/load"
import { parseRunbook } from "@runbooks/core/document/parse"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { RUNBOOKS_VERSION } from "../src/runbooks-version.ts"
import { BLOCKS } from "./standIns.ts"

const ROOT = path.resolve(import.meta.dir, "..")

const RUNBOOKS = [...new Bun.Glob("testdata/**/runbook.mdx").scanSync(ROOT)].sort((a, b) =>
  a.localeCompare(b),
)

/** Each read in `runbook` of an output its block does not declare, at its line. */
const undeclaredReads = (runbook: string) =>
  loadRunbook(path.join(ROOT, runbook), registry, { appVersion: RUNBOOKS_VERSION }).pipe(
    Effect.map((result) =>
      configErrors(result)
        .filter((error) => error.code === "undeclaredOutput")
        .map(
          ({ location, message }) =>
            `${path.relative(ROOT, location.file)}:${location.span.start.line}: ${message}`,
        ),
    ),
  )

const KEY = String.raw`(?:sensitive:)?([A-Za-z_][A-Za-z0-9_]*)=`
/** `echo "KEY=..."` or `printf 'KEY=...'`: the key as written, not computed. */
const ECHOED = new RegExp(String.raw`\b(?:echo|printf)\s+(?:-\w+\s+)*["']?${KEY}`)
/** Appends or writes to the outputs file: `>> "$RUNBOOK_OUTPUT"`, `>>"${RUNBOOK_OUTPUT:?...}"`. */
const TO_OUTPUT = String.raw`(?<!<)>>?\s*"?\$\{?RUNBOOK_OUTPUT\b`
const REDIRECTED = new RegExp(TO_OUTPUT)
const HEREDOC = new RegExp(String.raw`\bcat\s*${TO_OUTPUT}[^<]*<<-?\s*["']?(\w+)`)
const GROUP_END = new RegExp(String.raw`^\s*\}\s*${TO_OUTPUT}`)
const LINE_KEY = new RegExp(String.raw`^\s*${KEY}`)

/** The key each command on `line` echoes, split at `;`, `&&`, `||` and `|`. */
const echoed = (line: string, redirected: boolean) =>
  line
    .split(/;|&&|\|\|?/)
    .filter((command) => !redirected || REDIRECTED.test(command))
    .flatMap((command) => ECHOED.exec(command)?.[1] ?? [])

/**
 * The keys `script` writes to `$RUNBOOK_OUTPUT` as written in it: a
 * `KEY=...` that an `echo` or `printf` writes to the file, a `KEY=` line of
 * a heredoc `cat` writes to it, and the keys the `echo`s of a `{ ... }`
 * group written to it write. A key the script computes is not one of them.
 */
function writtenKeys(script: string): string[] {
  const lines = script.split("\n")
  const keys = new Set<string>()
  for (const [at, line] of lines.entries()) {
    if (line.trimStart().startsWith("#")) continue
    const heredoc = HEREDOC.exec(line)
    if (heredoc !== null) {
      const end = lines.findIndex((body, i) => i > at && body.trim() === heredoc[1])
      for (const body of lines.slice(at + 1, end === -1 ? undefined : end)) {
        const key = LINE_KEY.exec(body)?.[1]
        if (key !== undefined) keys.add(key)
      }
    } else if (GROUP_END.test(line)) {
      let start = at - 1
      while (start >= 0 && lines[start]?.trim() !== "{") start--
      for (const body of lines.slice(start + 1, at))
        for (const key of echoed(body, false)) keys.add(key)
    } else for (const key of echoed(line, true)) keys.add(key)
  }
  return [...keys]
}

/** Each key a Command in `runbook` writes to `$RUNBOOK_OUTPUT` and does not declare. */
function undeclaredWrites(runbook: string): string[] {
  const file = path.join(ROOT, runbook)
  const parsed = parseRunbook(readFileSync(file, "utf8"), BLOCKS, {
    file,
    appVersion: RUNBOOKS_VERSION,
  })
  if (parsed._tag === "Invalid")
    return [`${runbook}: does not parse: ${configErrors(parsed)[0]?.message ?? ""}`]
  return parsed.document.blocks.flatMap((node) => {
    // Props that do not decode are a configuration error: the block never runs.
    const props = node.props
    if (node.block !== registry.Command.name || !Schema.is(registry.Command.props)(props)) return []
    const scriptFile = path.join(path.dirname(file), props.path ?? "")
    // A script file that is not there is a `badFile` error, and writes nothing.
    const script = props.command ?? (existsSync(scriptFile) ? readFileSync(scriptFile, "utf8") : "")
    const declared = Object.keys(registry.Command.outputs(props))
    return writtenKeys(script)
      .filter((key) => !declared.includes(key))
      .map(
        (key) =>
          `${runbook}: <Command id="${node.idAsWritten ?? ""}"> writes ${key}: add "${key}" to its outputs`,
      )
  })
}

describe("declared outputs, against the testdata runbooks", () => {
  it("finds no runbook that reads an output its block does not declare", async () => {
    expect(RUNBOOKS.length).toBeGreaterThanOrEqual(44)
    const reads = await Effect.runPromise(
      Effect.forEach(RUNBOOKS, undeclaredReads).pipe(Effect.provide(NodeFileSystemLive)),
    )
    expect(reads.flat()).toEqual([])
  })

  it("finds no Command that writes an output key it does not declare", () => {
    expect(RUNBOOKS.flatMap(undeclaredWrites)).toEqual([])
  })
})

describe("the keys a script writes to $RUNBOOK_OUTPUT", () => {
  it("are each KEY= it writes there as written, in each form testdata uses", () => {
    const script = [
      `echo "a=1" >> "$RUNBOOK_OUTPUT"`,
      `printf 'b=%s\\n' "$B" >> $RUNBOOK_OUTPUT`,
      `echo "sensitive:c=$C" >> "$RUNBOOK_OUTPUT"`,
      `pwd; echo "d=$(pwd)" >> "\${RUNBOOK_OUTPUT:-/dev/null}" && echo done`,
      `cat >> "$RUNBOOK_OUTPUT" <<'END'`,
      `e=1`,
      `END`,
      `{`,
      `  echo "f=1"`,
      `} >>"\${RUNBOOK_OUTPUT:?unset}"`,
    ].join("\n")
    expect(writtenKeys(script).sort()).toEqual(["a", "b", "c", "d", "e", "f"])
  })

  it("leave out a key it computes, a comment, and a line that only passes the file along", () => {
    const script = [
      `echo "$KEY=1" >> "$RUNBOOK_OUTPUT"`,
      `# echo "g=1" >> "$RUNBOOK_OUTPUT"`,
      `./report.sh "$RUNBOOK_OUTPUT"`,
      `touch "$RUNBOOK_OUTPUT"`,
      `echo "h=1 goes to $RUNBOOK_OUTPUT"`,
      `echo "i=1" >&2`,
      `echo "j=1" > out.txt`,
    ].join("\n")
    expect(writtenKeys(script)).toEqual([])
  })
})
