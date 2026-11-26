/**
 * The two files a process task's script writes to, which the engine owns:
 * `$RUNBOOK_OUTPUT`, for its outputs, and `$RUNBOOK_ENV`, for what it gives
 * the blocks that name it in `envFrom`. The engine makes them in a folder
 * of the run's own, reads them once the run has ended well (exit 0 or 2),
 * and removes the folder when the run ends.
 *
 * Both take one format (the plan: `$RUNBOOK_ENV` takes the same format as
 * `$RUNBOOK_OUTPUT`):
 *
 * - `NAME=value`. The line is trimmed, so the value keeps its leading
 *   spaces and loses its trailing ones. The value runs to the line's end,
 *   `=` included.
 * - `NAME<<DELIMITER`, then the value's lines, then `DELIMITER` on a line
 *   of its own, for a value with newlines in it.
 * - `sensitive:NAME=value` marks an output sensitive. A name stays
 *   sensitive once marked, and its last value wins. Every variable in
 *   `$RUNBOOK_ENV` is held as sensitive, marked or not.
 * - Blank lines are skipped, and a line may end in `\r\n`.
 *
 * Reading is bounded (`RUN_FILE_LIMITS`). Any line Runbooks cannot read
 * fails the run, naming the file and the line, never what the line held.
 *
 * The run also gets `$GENERATED_FILES`, an empty folder of its own, as
 * today's app gives one. Once the run has ended well, the engine copies what
 * the script left there into the session's generated folder.
 */
import path from "node:path"
import { Data, Effect, Redacted, type Scope, Stream } from "effect"
import { TaskFailed } from "@runbooks/blocks-core/contract"
import { envNameProblem } from "../document/document.ts"
import { FileSystem, type WalkEntry } from "../services/FileSystem.ts"
import { type FileChange, LIMITS } from "./protocol.ts"

/** What the engine reads of a run file, at most. */
export const RUN_FILE_LIMITS = {
  /** Bytes in one file. */
  bytes: 1024 * 1024,
  /** Lines in one file. */
  lines: 10_000,
  /** Characters in a name. */
  nameLength: 256,
  /** Characters in a value. */
  valueLength: 128 * 1024,
  /** Problems a run's error names; it counts the rest. */
  problemsNamed: 10,
} as const

/** The variable that names each file. */
export type RunFile = "RUNBOOK_OUTPUT" | "RUNBOOK_ENV"

type LineProblem =
  | { readonly _tag: "NotNameValue" }
  | { readonly _tag: "NoDelimiter" }
  | { readonly _tag: "Unterminated" }
  | { readonly _tag: "NotAName" }
  | { readonly _tag: "NameTooLong" }
  /** The rest name a valid name, which a message may show. */
  | { readonly _tag: "Reserved"; readonly name: string }
  | { readonly _tag: "ValueTooLong"; readonly name: string }
  | { readonly _tag: "NulInValue"; readonly name: string }

type FileProblem = { readonly _tag: "TooLarge" } | { readonly _tag: "TooManyLines" }

/** A line, or a whole file, Runbooks cannot read. */
export type RunFileProblem =
  | { readonly file: RunFile; readonly line: number; readonly problem: LineProblem }
  | { readonly file: RunFile; readonly line?: never; readonly problem: FileProblem }

/** One name's value, as its last line left it. */
export interface Written {
  readonly value: Redacted.Redacted<string>
  /** A line marked it `sensitive:`. */
  readonly marked: boolean
}

export interface ParsedRunFile {
  readonly written: ReadonlyMap<string, Written>
  readonly problems: ReadonlyArray<RunFileProblem>
}

const SENSITIVE_PREFIX = "sensitive:"
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What is wrong with `name`, read from `file`. An output may take any name a shell can export. */
const nameProblem = (file: RunFile, name: string): LineProblem | undefined => {
  if (name.length > RUN_FILE_LIMITS.nameLength) return { _tag: "NameTooLong" }
  if (file === "RUNBOOK_OUTPUT") return NAME.test(name) ? undefined : { _tag: "NotAName" }
  switch (envNameProblem(name)) {
    case "notExportable":
      return { _tag: "NotAName" }
    case "reserved":
      return { _tag: "Reserved", name }
    case undefined:
      return undefined
  }
}

const valueProblem = (file: RunFile, name: string, value: string): LineProblem | undefined =>
  value.length > RUN_FILE_LIMITS.valueLength
    ? { _tag: "ValueTooLong", name }
    : // A process's environment cannot hold a NUL; an output may.
      file === "RUNBOOK_ENV" && value.includes("\0")
      ? { _tag: "NulInValue", name }
      : undefined

/** Reads `text`, the contents of `file`. Pure, so the test CLI can share it. */
export function parseRunFile(file: RunFile, text: string): ParsedRunFile {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  if (lines.at(-1) === "") lines.pop()
  if (lines.length > RUN_FILE_LIMITS.lines)
    return { written: new Map(), problems: [{ file, problem: { _tag: "TooManyLines" } }] }
  const written = new Map<string, Written>()
  const problems: RunFileProblem[] = []
  const problemAt = (line: number, problem: LineProblem) => problems.push({ file, line, problem })
  let index = 0
  while (index < lines.length) {
    const lineNumber = index + 1
    const line = lines[index]!.trim()
    index++
    if (line === "") continue
    const equals = line.indexOf("=")
    const heredoc = line.indexOf("<<")
    let rawName: string
    let value: string
    if (heredoc !== -1 && (equals === -1 || heredoc < equals)) {
      rawName = line.slice(0, heredoc)
      const delimiter = line.slice(heredoc + 2).trim()
      if (delimiter === "") {
        problemAt(lineNumber, { _tag: "NoDelimiter" })
        continue
      }
      const end = lines.findIndex((candidate, at) => at >= index && candidate.trim() === delimiter)
      if (end === -1) {
        // The rest of the file is the value, so nothing after it can be read.
        problemAt(lineNumber, { _tag: "Unterminated" })
        break
      }
      value = lines.slice(index, end).join("\n")
      index = end + 1
    } else if (equals === -1) {
      problemAt(lineNumber, { _tag: "NotNameValue" })
      continue
    } else {
      rawName = line.slice(0, equals)
      value = line.slice(equals + 1)
    }
    let name = rawName.trim()
    const marked = name.startsWith(SENSITIVE_PREFIX)
    if (marked) name = name.slice(SENSITIVE_PREFIX.length).trim()
    const problem = nameProblem(file, name) ?? valueProblem(file, name, value)
    if (problem !== undefined) {
      problemAt(lineNumber, problem)
      continue
    }
    written.set(name, {
      value: Redacted.make(value),
      marked: marked || (written.get(name)?.marked ?? false),
    })
  }
  return { written, problems }
}

const describeProblem = (problem: LineProblem | FileProblem): string => {
  switch (problem._tag) {
    case "NotNameValue":
      return "not NAME=value or NAME<<DELIMITER"
    case "NoDelimiter":
      return "NAME<< with no delimiter after it"
    case "Unterminated":
      return "a NAME<<DELIMITER value with no DELIMITER line to end it"
    case "NotAName":
      return "the name is not a variable name. Use letters, digits and underscores, and don't start with a digit"
    case "NameTooLong":
      return `the name is longer than ${RUN_FILE_LIMITS.nameLength} characters`
    case "Reserved":
      return `${problem.name} is a variable Runbooks sets for every script`
    case "ValueTooLong":
      return `the value of ${problem.name} is longer than ${RUN_FILE_LIMITS.valueLength} characters`
    case "NulInValue":
      return `the value of ${problem.name} holds a NUL character, which no environment variable can`
    case "TooLarge":
      return `it is larger than ${RUN_FILE_LIMITS.bytes} bytes, so none of it was read`
    case "TooManyLines":
      return `it has more than ${RUN_FILE_LIMITS.lines} lines, so none of it was read`
  }
}

/** The run's error for `problems`: each names its file and line, never what the line held. */
export const runFilesFailed = (problems: ReadonlyArray<RunFileProblem>): TaskFailed => {
  const named = problems
    .slice(0, RUN_FILE_LIMITS.problemsNamed)
    .map(
      ({ file, line, problem }) =>
        `$${file}${line === undefined ? "" : ` line ${line}`}: ${describeProblem(problem)}.`,
    )
  const more = problems.length - named.length
  return new TaskFailed({
    message: [
      "The script wrote what Runbooks cannot read, so the run failed.",
      ...named,
      ...(more > 0 ? [`And ${more} more.`] : []),
    ].join("\n"),
  })
}

/** Where a run's script writes, by the variable that names each file or folder. */
export type RunFiles = { readonly [file in RunFile | "GENERATED_FILES"]: string }

/** What a run's script wrote, once it is read. */
export interface RunWrote {
  readonly outputs: ReadonlyMap<string, Written>
  readonly env: ReadonlyMap<string, Redacted.Redacted<string>>
}

/** Makes the run's two files and its generated-files folder, empty, in a folder of its own that goes when `Scope` closes. */
export const makeRunFiles: Effect.Effect<RunFiles, TaskFailed, FileSystem | Scope.Scope> =
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const folder = yield* Effect.acquireRelease(fs.mkdtemp("runbooks-run-"), (made) =>
      Effect.ignore(fs.rm(made, { recursive: true, force: true })),
    )
    const files: RunFiles = {
      RUNBOOK_OUTPUT: path.join(folder, "output"),
      RUNBOOK_ENV: path.join(folder, "env"),
      GENERATED_FILES: path.join(folder, "files"),
    }
    yield* fs.writeFile(files.RUNBOOK_OUTPUT, "")
    yield* fs.writeFile(files.RUNBOOK_ENV, "")
    yield* fs.mkdir(files.GENERATED_FILES)
    return files
  }).pipe(
    Effect.mapError(
      () =>
        new TaskFailed({
          message:
            "Runbooks could not make the files and the folder a script writes its outputs, environment and generated files to.",
        }),
    ),
  )

const readRunFile = (file: RunFile, at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const head = yield* fs.readFileUpTo(at, RUN_FILE_LIMITS.bytes)
    return head.truncated
      ? { written: new Map(), problems: [{ file, problem: { _tag: "TooLarge" } } as const] }
      : parseRunFile(file, head.text)
  }).pipe(
    // A script may remove its file: then it wrote nothing.
    Effect.catchTag("FileNotFoundError", () =>
      Effect.succeed<ParsedRunFile>({ written: new Map(), problems: [] }),
    ),
    Effect.mapError(() => new TaskFailed({ message: `Runbooks could not read $${file}.` })),
  )

/** Reads what the run's script wrote to both files. */
export const readRunFiles = (files: RunFiles): Effect.Effect<RunWrote, TaskFailed, FileSystem> =>
  Effect.gen(function* () {
    const outputs = yield* readRunFile("RUNBOOK_OUTPUT", files.RUNBOOK_OUTPUT)
    const env = yield* readRunFile("RUNBOOK_ENV", files.RUNBOOK_ENV)
    const problems = [...outputs.problems, ...env.problems]
    if (problems.length > 0) return yield* Effect.fail(runFilesFailed(problems))
    return {
      outputs: outputs.written,
      env: new Map(Array.from(env.written, ([name, { value }]) => [name, value])),
    }
  })

/** What `copyGenerated` copied, and what it would not. */
export interface Copied {
  /** Each file it copied, by its path in the generated folder: the first `LIMITS.maxRunFiles`. */
  readonly changes: ReadonlyArray<FileChange>
  /** Whether it copied more files than `changes` lists. */
  readonly truncated: boolean
  /** Each symbolic link the script left, by its path in `$GENERATED_FILES`, which it does not copy. */
  readonly links: ReadonlyArray<string>
}

/**
 * Copies what a run's script left in `$GENERATED_FILES` (`from`) into the
 * session's generated folder, as today's app does: folders and files, not
 * symbolic links. A file is `modified` if the generated folder had one at
 * its path, else `created`. A file whose place in the generated folder leads
 * out of it, through a link there, is refused, and the run fails.
 *
 * A copy that stops part way fails with what it had copied by then, since
 * those files are in the generated folder.
 */
export const copyGenerated = (
  from: string,
  generated: string,
): Effect.Effect<Copied, CopyFailed, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const changes: FileChange[] = []
    const links: string[] = []
    let truncated = false
    const copied = (): Copied => ({ changes, truncated, links })
    const copy = (entry: WalkEntry) =>
      Effect.gen(function* () {
        const to = path.join(generated, entry.relativePath)
        if (!entry.isFile && !entry.isDirectory) {
          if (links.length < LIMITS.maxRunFiles) links.push(entry.relativePath)
          return
        }
        if (!(yield* fs.isContainedInReal(to, generated)))
          return yield* new TaskFailed({
            message: `Runbooks did not copy ${entry.relativePath} from $GENERATED_FILES: its place in the generated folder leads outside it.`,
          })
        if (entry.isDirectory) return yield* fs.mkdir(to, { recursive: true })
        const existed = yield* fs.exists(to)
        yield* fs.mkdir(path.dirname(to), { recursive: true })
        yield* fs.copyFile(entry.path, to)
        if (changes.length < LIMITS.maxRunFiles)
          changes.push({ path: to, change: existed ? "modified" : "created" })
        else truncated = true
      }).pipe(
        Effect.catchTags({
          FileWriteError: () =>
            Effect.fail(
              new TaskFailed({
                message: `Runbooks could not copy ${entry.relativePath} from $GENERATED_FILES into the generated folder.`,
              }),
            ),
        }),
      )
    yield* fs.walk(from).pipe(
      Stream.mapError(
        () => new TaskFailed({ message: "Runbooks could not read $GENERATED_FILES." }),
      ),
      Stream.runForEach(copy),
      Effect.mapError((failure) => new CopyFailed({ failure, copied: copied() })),
    )
    return copied()
  })

/** A copy from `$GENERATED_FILES` stopped at `failure`, having copied `copied`. */
export class CopyFailed extends Data.TaggedError("CopyFailed")<{
  readonly failure: TaskFailed
  readonly copied: Copied
}> {}
