/**
 * `runbook_test.yml`: the answers a runbook's tests give and what each test
 * expects. Its format is today's (`docs/.../authoring/testing.mdx`), with
 * two changes: a key the format does not have is an error, where today it is
 * ignored (`expects:` fell back to success), and what a step may say about a
 * block comes from the block's definition in the registry.
 *
 * Two layers, one source, the table of what each kind of block allows:
 *
 * - `TestFile`, the format: every key any kind of block allows. The JSON
 *   Schema for editors is this schema's (`testFileJsonSchema`).
 * - `bindTestFile`, the binding to one runbook: each step's block found
 *   through the registry, and the step held to what that block's kind
 *   allows. A runbook is needed for it, so an editor's schema cannot carry
 *   it.
 */
import { Effect, Result, Schema, SchemaIssue } from "effect"
import { parseYaml, yamlData } from "@runbooks/core/document/yamlData"
import { isMap, isScalar, isSeq, type LineCounter, type Node } from "yaml"
import { isIdWord, type MachineEffect } from "@runbooks/blocks-core/contract"
import type { AnyBlock, Registry } from "@runbooks/blocks-core/registry"
import { resolveTag } from "@runbooks/blocks-core/registry"
import type { RunbookDocument } from "@runbooks/core/document/document"
import { nearest } from "@runbooks/core/document/nearest"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { ExpectedStatus } from "./contract.ts"

// ---------------------------------------------------------------------------
// What each kind of block allows
// ---------------------------------------------------------------------------

/**
 * A block's kind, for a test: its class, unless it is external. A block that
 * declares the `push` effect, or uses a plugin at a level beyond `read`, is
 * external: a test cannot reach what it changes, so it is only skipped.
 */
export const StepKind = Schema.Literals(["display", "form", "task", "credential", "external"])
export type StepKind = typeof StepKind.Type

/** Why a block is external: what it declares that a test cannot undo. Undefined for one that is not. */
export function externalBecause(block: AnyBlock): string | undefined {
  const effects: ReadonlyArray<MachineEffect> = block.effects
  if (effects.includes("push")) return "declares push"
  if (!("plugins" in block)) return undefined
  for (const use of block.plugins) {
    const level = use.levels.find((l) => l !== "read")
    if (level !== undefined) return `uses the plugin ${use.plugin} to ${level}`
  }
  return undefined
}

export const kindOf = (block: AnyBlock): StepKind =>
  externalBecause(block) === undefined ? block.class : "external"

/** The keys a step may have besides `block` and `expect`. */
type StepKey = "env_prefix" | "missing_outputs" | "error_contains" | "assertions" | "set_outputs"

interface KindRules {
  /** The first is what a step that says no `expect` expects, when it is allowed. */
  readonly expects: ReadonlyArray<ExpectedStatus>
  readonly keys: ReadonlyArray<StepKey>
}

/**
 * What a step may say about a block of each kind.
 *
 * - A display block does not run: it can only be misconfigured or skipped.
 * - A form succeeds when its values are accepted, and fails when they are not.
 * - Only a task can warn, or be hidden by `showWhenBlock`.
 * - A credential can wait on a block it reads outputs from, so it can be blocked.
 * - An external block only skips, and says so.
 *
 * `error_contains` goes with `config_error`, `missing_outputs` with
 * `blocked` and `set_outputs` with a form that declares outputs.
 */
export const KIND_RULES: { readonly [K in StepKind]: KindRules } = {
  display: { expects: ["success", "skip", "config_error"], keys: ["error_contains"] },
  form: {
    expects: ["success", "fail", "skip", "config_error"],
    keys: ["error_contains", "assertions", "set_outputs"],
  },
  task: {
    expects: ["success", "fail", "warn", "blocked", "skip", "hidden", "config_error"],
    keys: ["error_contains", "missing_outputs", "assertions"],
  },
  credential: {
    expects: ["success", "fail", "blocked", "skip", "config_error"],
    keys: ["env_prefix", "error_contains", "missing_outputs", "assertions"],
  },
  external: { expects: ["skip"], keys: [] },
}

/** What a step that says no `expect` expects. An external block's step must say `skip`. */
export const DEFAULT_EXPECT: ExpectedStatus = "success"

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

const Text = Schema.NonEmptyString
/** A block's id as the runbook writes it. */
const BlockName = Schema.String.check(isIdWord)
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A duration as `timeout` takes it: `500ms`, `30s`, `5m`, `1h`. */
export const Duration = Schema.String.check(Schema.isPattern(/^\d+(ms|s|m|h)$/u))

export const Settings = Schema.Struct({
  use_temp_working_dir: Schema.optionalKey(Schema.Boolean),
  working_dir: Schema.optionalKey(Schema.String),
  output_path: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Duration),
  parallelizable: Schema.optionalKey(Schema.Boolean),
})

export const FuzzType = Schema.Literals([
  "string",
  "int",
  "float",
  "bool",
  "enum",
  "email",
  "url",
  "uuid",
  "date",
  "timestamp",
  "words",
  "list",
  "map",
])

export const FuzzConfig = Schema.Struct({
  type: FuzzType,
  length: Schema.optionalKey(Count),
  minLength: Schema.optionalKey(Count),
  maxLength: Schema.optionalKey(Count),
  pattern: Schema.optionalKey(Schema.String),
  prefix: Schema.optionalKey(Schema.String),
  suffix: Schema.optionalKey(Schema.String),
  includeSpaces: Schema.optionalKey(Schema.Boolean),
  includeSpecialChars: Schema.optionalKey(Schema.Boolean),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  domain: Schema.optionalKey(Schema.String),
  minDate: Schema.optionalKey(Schema.String),
  maxDate: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.String),
  wordCount: Schema.optionalKey(Count),
  minWordCount: Schema.optionalKey(Count),
  maxWordCount: Schema.optionalKey(Count),
  count: Schema.optionalKey(Count),
  minCount: Schema.optionalKey(Count),
  maxCount: Schema.optionalKey(Count),
  schema: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * A value as written: text, a number, true or false, empty, a list or a map.
 * A map with a `fuzz` key is a fuzz configuration, never a value, so one
 * that is wrong is an error rather than a map passed on as written.
 */
const LiteralValue: Schema.Codec<unknown> = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend((): Schema.Codec<unknown> => LiteralValue)),
  Schema.Record(
    Schema.String.check(Schema.isPattern(/^(?!fuzz$)/u)),
    Schema.suspend((): Schema.Codec<unknown> => LiteralValue),
  ),
]) as Schema.Codec<unknown>

export const InputValue = Schema.Union([Schema.Struct({ fuzz: FuzzConfig }), LiteralValue])

/** `inputsID.varName`: the block whose fields it answers, and the field. */
export const InputKey = Schema.String.check(Schema.isPattern(/^[^.\s]+\.[^.\s]+$/u))

const pathAssertion = <T extends string>(type: T) =>
  Schema.Struct({ type: Schema.Literal(type), path: Text })

export const Assertion = Schema.Union([
  pathAssertion("file_exists"),
  pathAssertion("file_not_exists"),
  pathAssertion("dir_exists"),
  pathAssertion("dir_not_exists"),
  Schema.Struct({ type: Schema.Literal("file_contains"), path: Text, contains: Text }),
  Schema.Struct({ type: Schema.Literal("file_not_contains"), path: Text, contains: Text }),
  Schema.Struct({ type: Schema.Literal("file_matches"), path: Text, pattern: Text }),
  Schema.Struct({ type: Schema.Literal("file_equals"), path: Text, value: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("output_equals"),
    block: BlockName,
    output: Text,
    value: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("output_matches"),
    block: BlockName,
    output: Text,
    pattern: Text,
  }),
  Schema.Struct({ type: Schema.Literal("output_exists"), block: BlockName, output: Text }),
  Schema.Struct({
    type: Schema.Literal("files_generated"),
    block: BlockName,
    min_count: Schema.optionalKey(Count),
  }),
  Schema.Struct({ type: Schema.Literal("script"), command: Text }),
])
export type Assertion = typeof Assertion.Type

const STEP_FIELDS = {
  env_prefix: Schema.String,
  missing_outputs: Schema.Array(Text),
  error_contains: Text,
  assertions: Schema.Array(Assertion),
  set_outputs: Schema.Record(Text, Schema.String),
} satisfies { readonly [K in StepKey]: Schema.Top }

/** Every key some kind of block allows, from `KIND_RULES`. */
const allowedKeys: ReadonlyArray<StepKey> = [
  ...new Set(Object.values(KIND_RULES).flatMap(({ keys }) => keys)),
]
const allowedExpects: ReadonlyArray<ExpectedStatus> = ExpectedStatus.literals.filter((status) =>
  Object.values(KIND_RULES).some(({ expects }) => expects.includes(status)),
)

const optionalFields = Object.fromEntries(
  allowedKeys.map((key) => [key, Schema.optionalKey(STEP_FIELDS[key])]),
) as { readonly [K in StepKey]: Schema.optionalKey<(typeof STEP_FIELDS)[K]> }

export const Step = Schema.Struct({
  /** The block's id. */
  block: BlockName,
  expect: Schema.optionalKey(Schema.Literals(allowedExpects)),
  ...optionalFields,
})
export type Step = typeof Step.Type

export const Cleanup = Schema.Union([
  Schema.Struct({ command: Text }),
  Schema.Struct({ path: Text }),
])

/**
 * A list or map a test case may leave empty: absent, or a key with nothing
 * after it, as the generated `runbook_test.yml` writes `steps:` above its
 * commented-out steps.
 */
const mayBeEmpty = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

export const TestCase = Schema.Struct({
  name: Text,
  description: Schema.optionalKey(Schema.String),
  env: mayBeEmpty(Schema.Record(Schema.String, Schema.String)),
  inputs: mayBeEmpty(Schema.Record(InputKey, InputValue)),
  /** Absent or empty: every block once, in document order. */
  steps: mayBeEmpty(Schema.Array(Step)),
  assertions: mayBeEmpty(Schema.Array(Assertion)),
  cleanup: mayBeEmpty(Schema.Array(Cleanup)),
})
export type TestCase = typeof TestCase.Type

export const TestFile = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  settings: Schema.optionalKey(Settings),
  tests: Schema.Array(TestCase).check(Schema.isMinLength(1)),
})
export type TestFile = typeof TestFile.Type

/**
 * The JSON Schema file an editor checks `runbook_test.yml` against:
 * `TestFile`'s, keys closed, as one Draft 2020-12 document. It holds the
 * format only: what a step may say about a block needs the runbook.
 */
export function testFileJsonSchema(): string {
  const { schema, definitions } = Schema.toJsonSchemaDocument(TestFile, {
    onExcessProperty: "error",
  })
  const file = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "runbook_test.yml",
    description: "The tests of the runbook in the same folder, for `runbooks test`.",
    ...schema,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Every key the format has somewhere, for the suggestion a misspelt one gets. */
const KNOWN_KEYS: ReadonlyArray<string> = [
  ...new Set(
    [
      TestFile,
      Settings,
      TestCase,
      Step,
      FuzzConfig,
      ...Assertion.members,
      ...Cleanup.members,
    ].flatMap((struct) => Object.keys(struct.fields)),
  ),
]

// ---------------------------------------------------------------------------
// The binding to one runbook
// ---------------------------------------------------------------------------

/** What a test file may say about one block of a runbook. */
export interface Target {
  /** The tag as written, for messages. */
  readonly tag: string
  readonly kind: StepKind
  /** For an external block, why: `externalBecause`. */
  readonly external?: string
  /** The outputs it declares; undefined when its props do not decode. */
  readonly outputs: ReadonlyArray<string> | undefined
  /** Whether `inputs` may answer its fields: a form, or a task with a form of its own. */
  readonly takesInputs: boolean
}

/** Each block of `document` with an id, by the id as written and as templates write it. */
export function targetsOf(document: RunbookDocument, registry: Registry): Map<string, Target> {
  const targets = new Map<string, Target>()
  for (const node of document.blocks) {
    const block = resolveTag(registry, node.tag)?.block
    if (block === undefined || node.id === undefined) continue
    const outputs =
      node.props === undefined || block.class === "display"
        ? undefined
        : Object.keys(block.outputs(node.props as never))
    const external = externalBecause(block)
    const target: Target = {
      tag: node.tag,
      kind: kindOf(block),
      ...(external === undefined ? {} : { external }),
      outputs,
      takesInputs: block.class === "form" || (block.class === "task" && block.fields !== undefined),
    }
    targets.set(node.id, target)
    if (node.idAsWritten !== undefined) targets.set(node.idAsWritten, target)
  }
  return targets
}

const quoted = (values: ReadonlyArray<string>) => values.map((v) => `"${v}"`).join(", ")

type Issue = { readonly path: ReadonlyArray<PropertyKey>; readonly issue: string }

function stepIssues(step: Step, at: ReadonlyArray<PropertyKey>, target: Target): Issue[] {
  const issues: Issue[] = []
  const rules = KIND_RULES[target.kind]
  const what = `<${target.tag}> "${step.block}"`
  const expect = step.expect ?? DEFAULT_EXPECT
  if (!rules.expects.includes(expect))
    issues.push({
      path: step.expect === undefined ? at : [...at, "expect"],
      issue:
        target.kind === "external"
          ? `${what} ${target.external ?? "is external"}, so a test only skips it: say expect: skip`
          : `${what} cannot be expected to be ${expect}. Expected one of ${quoted(rules.expects)}`,
    })
  for (const key of allowedKeys) {
    if (step[key] === undefined) continue
    if (!rules.keys.includes(key))
      issues.push({ path: [...at, key], issue: `A step for ${what} cannot have ${key}` })
  }
  if (step.error_contains !== undefined && expect !== "config_error")
    issues.push({
      path: [...at, "error_contains"],
      issue: "error_contains goes with expect: config_error",
    })
  if (step.missing_outputs !== undefined && expect !== "blocked")
    issues.push({
      path: [...at, "missing_outputs"],
      issue: "missing_outputs goes with expect: blocked",
    })
  if (step.set_outputs !== undefined && rules.keys.includes("set_outputs")) {
    const declared = target.outputs
    if (declared !== undefined)
      for (const name of Object.keys(step.set_outputs))
        if (!declared.includes(name))
          issues.push({
            path: [...at, "set_outputs", name],
            issue:
              declared.length === 0
                ? `${what} declares no outputs`
                : `${what} declares no output "${name}". It declares ${quoted(declared)}`,
          })
  }
  return issues
}

/**
 * The issues in `file` against the runbook's blocks. A step or assertion
 * that names no block is left to the run, which fails it, as today.
 */
function bindingIssues(file: TestFile, targets: ReadonlyMap<string, Target>): Issue[] {
  const issues: Issue[] = []
  file.tests.forEach((test, t) => {
    test.steps?.forEach((step, s) => {
      const target = targets.get(step.block)
      if (target !== undefined) issues.push(...stepIssues(step, ["tests", t, "steps", s], target))
    })
    for (const key of Object.keys(test.inputs ?? {})) {
      const id = key.slice(0, key.indexOf("."))
      const target = targets.get(id)
      if (target === undefined || !target.takesInputs)
        issues.push({
          path: ["tests", t, "inputs", key],
          issue:
            target === undefined
              ? `No block in the runbook has the id "${id}"`
              : `<${target.tag}> "${id}" has no fields for inputs to answer`,
        })
    }
  })
  return issues
}

/** `TestFile` bound to a runbook's blocks. */
export const boundTestFile = (targets: ReadonlyMap<string, Target>) =>
  TestFile.check(Schema.makeFilter((file: TestFile) => bindingIssues(file, targets)))

// ---------------------------------------------------------------------------
// Reading one
// ---------------------------------------------------------------------------

/** The largest `runbook_test.yml` the CLI reads. */
export const MAX_TEST_FILE_BYTES = 1024 * 1024

/** A test file that cannot be used, with each problem at its line. */
export class TestFileError extends Schema.TaggedError<TestFileError>()("TestFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** What Effect says of a key a struct does not have. */
const EXCESS = "Expected no excess property"

/**
 * The YAML node a decode issue at `path` points at: for a key, the key
 * itself, so an unexpected key's line is its own; for a key that is
 * missing, the map that lacks it.
 */
function nodeAt(root: Node | null, path: ReadonlyArray<PropertyKey>): Node | null {
  let node = root
  for (const [i, key] of path.entries()) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(key))
      if (pair === undefined) return node
      if (i === path.length - 1) return pair.key as Node
      node = pair.value as Node | null
    } else if (isSeq(node)) {
      const item = typeof key === "number" ? node.items[key] : undefined
      if (item === undefined) return node
      node = item as Node
    } else return node
  }
  return node
}

/** A decode path as a person reads it: `tests[0].inputs["form.region"]`. */
export function pathText(keys: ReadonlyArray<PropertyKey>): string {
  return keys
    .map((key, i) =>
      typeof key === "number"
        ? `[${key}]`
        : /^[A-Za-z_][\w-]*$/u.test(String(key))
          ? `${i === 0 ? "" : "."}${String(key)}`
          : `[${JSON.stringify(String(key))}]`,
    )
    .join("")
}

/**
 * Each issue as `file:line:column: path: message`. Where a value could be
 * one of several shapes, each shape it fails is an issue. A key one shape
 * lacks is not reported when another shape has it and found a problem
 * inside it: `fuzz` is not a key of a map value, but it is the fuzz
 * configuration's.
 */
function located(
  file: string,
  issue: SchemaIssue.Issue,
  root: Node | null,
  lines: LineCounter,
): string[] {
  const issues = formatIssue(issue).issues.map(({ path, message }) => ({
    keys: (path ?? []).map((key) => (typeof key === "object" ? key.key : key)),
    message,
  }))
  const isUnder = (keys: ReadonlyArray<PropertyKey>, prefix: ReadonlyArray<PropertyKey>) =>
    keys.length > prefix.length && prefix.every((key, i) => keys[i] === key)
  return issues
    .filter(
      ({ keys, message }) =>
        message !== EXCESS || !issues.some((other) => isUnder(other.keys, keys)),
    )
    .map(({ keys, message }) => {
      const offset = nodeAt(root, keys)?.range?.[0] ?? 0
      const { line, col } = lines.linePos(offset)
      const where = keys.length === 0 ? "" : `${pathText(keys)}: `
      const key = keys.at(-1)
      if (message !== EXCESS || typeof key !== "string")
        return `${file}:${line}:${col}: ${where}${message}`
      if (keys.at(-2) === "inputs")
        return `${file}:${line}:${col}: ${where}an input is written <block id>.<field>, as config.region`
      const suggestion = nearest(key, KNOWN_KEYS)
      return `${file}:${line}:${col}: ${where}there is no key ${key} here.${suggestion === undefined ? "" : ` Did you mean ${suggestion}?`}`
    })
}

/**
 * `text`, a `runbook_test.yml`, decoded against `schema`. Every problem is
 * in the error, each with its line: YAML that does not parse, a key the
 * format does not have, a value of the wrong type, a step its block does
 * not allow.
 */
export function parseTestFile(
  file: string,
  text: string,
  schema: Schema.Codec<TestFile, unknown> = TestFile,
): Effect.Effect<TestFile, TestFileError> {
  const { doc, lines, problems } = parseYaml(text)
  if (problems.length > 0)
    return Effect.fail(
      new TestFileError({
        path: file,
        message: problems
          .map(({ line, column, reason }) => `${file}:${line}:${column}: ${reason}.`)
          .join("\n"),
      }),
    )
  const data = yamlData(doc)
  if (Result.isFailure(data)) {
    const { line, col } = lines.linePos(data.failure.offset)
    return Effect.fail(
      new TestFileError({ path: file, message: `${file}:${line}:${col}: ${data.failure.message}` }),
    )
  }
  return Schema.decodeUnknownEffect(schema)(data.success, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    Effect.mapError(
      ({ issue }) =>
        new TestFileError({
          path: file,
          message: located(file, issue, doc.contents, lines).join("\n"),
        }),
    ),
  )
}

/**
 * Reads and decodes the `runbook_test.yml` at `file`, up to
 * `MAX_TEST_FILE_BYTES`. Its errors name it as `shown`.
 */
export const readTestFile = (
  file: string,
  schema: Schema.Codec<TestFile, unknown> = TestFile,
  shown: string = file,
): Effect.Effect<TestFile, TestFileError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const { text, truncated } = yield* fs.readFileUpTo(file, MAX_TEST_FILE_BYTES).pipe(
      Effect.mapError(
        (error) =>
          new TestFileError({
            path: shown,
            message:
              error._tag === "FileNotFoundError"
                ? `${shown} does not exist.`
                : `${shown} could not be read: ${String(error.cause)}`,
          }),
      ),
    )
    if (truncated)
      return yield* new TestFileError({
        path: shown,
        message: `${shown} is larger than ${MAX_TEST_FILE_BYTES} bytes.`,
      })
    return yield* parseTestFile(shown, text, schema)
  })
