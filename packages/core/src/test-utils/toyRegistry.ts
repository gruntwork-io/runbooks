/**
 * A registry of toy blocks, one per kind of thing the parser and the graph
 * must handle. No real block has their tags: only a block's folder may name
 * it (`runbooks/block-name-outside-its-folder`), and the core's tests test
 * the core, not a block.
 */
import { Effect, Option, Schema, Stream } from "effect"
import {
  type Alias,
  BlockId,
  defineCredential,
  defineDisplay,
  defineForm,
  defineTask,
  RunbookPath,
} from "@runbooks/blocks-core/contract"
import { FieldType, FieldValue, type FormSpec, Validation } from "@runbooks/blocks-core/form"
import type { Registry } from "@runbooks/blocks-core/registry"

const toPath = Schema.decodeSync(RunbookPath)

/** Display, markdown children, its own `title` and `description`, which are shared props too. */
const note = defineDisplay({
  name: "Note",
  since: "0.1.0",
  class: "display",
  props: Schema.Struct({
    type: Schema.optionalKey(Schema.Literals(["note", "info", "warning", "danger"])),
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    allowPermanentHide: Schema.optionalKey(Schema.Boolean),
  }),
  children: { kind: "markdown" },
  references: {},
  runbookFiles: () => [],
  provides: [],
  effects: [],
})

const RunProps = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  shell: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  outputs: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * Task with the process effect: takes `dependsOn`, `envFrom` and `env`, and
 * gives environment to blocks that name it in `envFrom`. Outputs what
 * `outputs` lists.
 */
const run = defineTask({
  name: "Run",
  since: "0.1.0",
  class: "task",
  props: RunProps,
  children: { kind: "none" },
  references: {},
  runbookFiles: (p) => (p.path === undefined ? [] : [toPath(p.path)]),
  provides: ["run", "env"],
  effects: ["process"],
  outputs: (p) => Object.fromEntries((p.outputs ?? []).map((key) => [key, { sensitive: false }])),
  run: () => Stream.empty,
  instruction: (p) => [{ kind: "code", language: p.shell ?? "bash", code: p.command ?? "" }],
  plugins: [],
})

/** A field as a toy form's YAML writes it: a `Field` whose flags default to off. */
const ToyField = Schema.Struct({
  name: Schema.String,
  type: FieldType,
  default: Schema.optionalKey(FieldValue),
  required: Schema.optionalKey(Schema.Boolean),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  validations: Schema.optionalKey(Schema.Array(Validation)),
  sensitive: Schema.optionalKey(Schema.Boolean),
  locked: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
  showWhen: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
})

const toyFormSpec = (fields: ReadonlyArray<typeof ToyField.Type>): FormSpec => ({
  fields: fields.map((field) => ({
    description: "",
    required: false,
    validations: [],
    sensitive: false,
    locked: false,
    hidden: false,
    ...field,
  })),
  sections: [],
})

/** Form whose fields come from fenced YAML children. */
const form = defineForm({
  name: "Form",
  since: "0.1.0",
  class: "form",
  props: Schema.Struct({ variables: Schema.Array(ToyField) }),
  children: { kind: "yaml", prop: "variables" },
  references: {},
  runbookFiles: () => [],
  provides: ["values"],
  effects: [],
  outputs: (p) => Object.fromEntries(p.variables.map((v) => [v.name, { sensitive: false }])),
  fields: (p) => Effect.succeed(toyFormSpec(p.variables)),
  plugins: [],
})

/** Task that names a form by a reference prop of its own. */
const clone = defineTask({
  name: "Clone",
  since: "0.1.0",
  class: "task",
  props: Schema.Struct({
    url: Schema.String,
    gitAuthId: Schema.optionalKey(BlockId),
  }),
  children: { kind: "none" },
  references: { gitAuthId: "git-credential" },
  runbookFiles: () => [],
  provides: ["run", "repository"],
  effects: ["network"],
  outputs: () => ({ path: { sensitive: false } }),
  run: () => Stream.empty,
  instruction: (p) => [{ kind: "code", language: "bash", code: `git clone ${p.url}` }],
  plugins: [],
})

const GitLoginProps = Schema.Struct({
  provider: Schema.optionalKey(Schema.Literals(["github", "gitlab"])),
})

/** Credential: gives environment, and a git credential to blocks that name it in `gitAuthId`. */
const gitLogin = defineCredential({
  name: "GitLogin",
  since: "0.1.0",
  class: "credential",
  props: GitLoginProps,
  children: { kind: "none" },
  references: {},
  runbookFiles: () => [],
  provides: ["env", "git-credential"],
  effects: ["network"],
  scope: "git",
  provider: "git",
  outputs: () => ({ user: { sensitive: false } }),
  request: () => ({
    detect: [],
    pins: {},
    requirements: [],
    settings: {},
    defaultMethod: Option.none(),
    methodDefaults: {},
  }),
  instruction: () => [],
})

const gitHubLogin: Alias<typeof GitLoginProps.Type> = {
  name: "GitHubLogin",
  since: "0.1.0",
  of: "GitLogin",
  locked: { provider: "github" },
}

const bash: Alias<typeof RunProps.Type> = {
  name: "Bash",
  since: "0.2.0",
  of: "Run",
  locked: { shell: "bash" },
}

export const TOY_REGISTRY = {
  Note: note,
  Run: run,
  Form: form,
  Clone: clone,
  GitLogin: gitLogin,
  GitHubLogin: gitHubLogin,
  Bash: bash,
} satisfies Registry
