/**
 * A registry of toy blocks, one per kind of thing the parser, the graph and
 * the engine must handle. No real block has their tags: only a block's folder may name
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
import {
  FieldType,
  FieldValue,
  type FormSpec,
  OptionsSource,
  Validation,
} from "@runbooks/blocks-core/form"
import type { Registry } from "@runbooks/blocks-core/registry"

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
  path: Schema.optionalKey(RunbookPath),
  shell: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  outputs: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * Task with the process effect: takes `dependsOn`, `envFrom` and `env`, and
 * gives environment to blocks that name it in `envFrom`. Outputs what
 * `outputs` lists. Takes markdown children, as Command does, so a form can
 * nest in it.
 */
const run = defineTask({
  name: "Run",
  since: "0.1.0",
  class: "task",
  props: RunProps,
  children: { kind: "markdown" },
  references: {},
  runbookFiles: (p) => (p.path === undefined ? [] : [p.path]),
  provides: ["run", "env"],
  effects: ["process"],
  outputs: (p) => Object.fromEntries((p.outputs ?? []).map((key) => [key, { sensitive: false }])),
  run: () => Stream.empty,
  instruction: (p) => [{ kind: "code", language: p.shell ?? "bash", code: p.command ?? "" }],
  plugins: [],
})

/** A field as a toy form's YAML writes it: a `Field` whose flags default to off. */
export const ToyField = Schema.Struct({
  name: Schema.String,
  type: FieldType,
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(FieldValue),
  required: Schema.optionalKey(Schema.Boolean),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  optionLabels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionsFrom: Schema.optionalKey(OptionsSource),
  schema: Schema.optionalKey(Schema.Record(Schema.String, FieldType)),
  schemaInstanceLabel: Schema.optionalKey(Schema.String),
  section: Schema.optionalKey(Schema.String),
  validations: Schema.optionalKey(Schema.Array(Validation)),
  sensitive: Schema.optionalKey(Schema.Boolean),
  locked: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
  showWhen: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
})

export const toyFormSpec = (fields: ReadonlyArray<typeof ToyField.Type>): FormSpec => ({
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

/** Form whose fields come from fenced YAML children. Each field is also an output of its name. */
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
  outputs: (p) => Object.fromEntries(p.variables.map((v) => [v.name, { field: v.name }])),
  fields: (p) => Effect.succeed(toyFormSpec(p.variables)),
  plugins: [],
})

/**
 * Form like DirPicker: fields from fenced YAML children, and outputs from its
 * `outputs` prop, each naming the field it carries. `outputs={{ PATH: "path" }}`
 * publishes the field `path` as `PATH`.
 */
const publisher = defineForm({
  name: "Publisher",
  since: "0.1.0",
  class: "form",
  props: Schema.Struct({
    variables: Schema.Array(ToyField),
    outputs: Schema.Record(Schema.String, Schema.String),
  }),
  children: { kind: "yaml", prop: "variables" },
  references: {},
  runbookFiles: () => [],
  provides: ["values"],
  effects: [],
  outputs: (p) =>
    Object.fromEntries(Object.entries(p.outputs).map(([output, field]) => [output, { field }])),
  fields: (p) => Effect.succeed(toyFormSpec(p.variables)),
  plugins: [],
})

/**
 * Form like an Iframe with `outputs`: one required text field per output,
 * named by it, which a client sets on the page's behalf.
 */
const embed = defineForm({
  name: "Embed",
  since: "0.1.0",
  class: "form",
  props: Schema.Struct({ outputs: Schema.Array(Schema.String) }),
  children: { kind: "none" },
  references: {},
  runbookFiles: () => [],
  provides: ["values"],
  effects: [],
  outputs: (p) => Object.fromEntries(p.outputs.map((name) => [name, { field: name }])),
  fields: (p) =>
    Effect.succeed(
      toyFormSpec(p.outputs.map((name) => ({ name, type: "string", required: true }))),
    ),
  plugins: [],
})

/** Task that names a credential by a reference prop of its own, and makes a repository. */
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
  paths: (p) => ({
    target: {
      root: "working",
      path:
        p.url
          .replace(/\.git$/, "")
          .split("/")
          .at(-1) ?? "repo",
    },
  }),
  repository: "target",
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
  envNames: ["GITHUB_TOKEN", "GITLAB_TOKEN"],
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

/**
 * Credential with every part of a request: detection from the environment
 * (off with `detect={false}`) and from an earlier block's outputs, `account`
 * and `role` pins, required scopes, a region setting, a default method and
 * per-method field defaults. Its provider is named "cloud".
 */
const cloudLogin = defineCredential({
  name: "CloudLogin",
  since: "0.1.0",
  class: "credential",
  props: Schema.Struct({
    account: Schema.optionalKey(Schema.String),
    role: Schema.optionalKey(Schema.String),
    detect: Schema.optionalKey(Schema.Boolean),
    prefix: Schema.optionalKey(Schema.String),
    keysFrom: Schema.optionalKey(BlockId),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    region: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.String),
    defaults: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
    ),
  }),
  children: { kind: "none" },
  references: { keysFrom: "run" },
  runbookFiles: () => [],
  provides: ["env"],
  effects: ["network", "browser"],
  scope: "cloud",
  provider: "cloud",
  envNames: ["CLOUD_TOKEN", "CLOUD_ACCOUNT"],
  outputs: () => ({ account: { sensitive: false }, token: { sensitive: true } }),
  request: (p) => ({
    detect:
      p.detect === false
        ? []
        : [
            { kind: "env", prefix: Option.fromUndefinedOr(p.prefix) },
            ...(p.keysFrom === undefined ? [] : [{ kind: "outputs" as const, from: p.keysFrom }]),
          ],
    pins: {
      ...(p.account === undefined ? {} : { account: p.account }),
      ...(p.role === undefined ? {} : { role: p.role }),
    },
    requirements: p.scopes === undefined ? [] : [{ kind: "scopes", scopes: p.scopes }],
    settings: p.region === undefined ? {} : { defaultRegion: p.region },
    defaultMethod: Option.fromUndefinedOr(p.method),
    methodDefaults: p.defaults ?? {},
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
  Publisher: publisher,
  Embed: embed,
  Clone: clone,
  GitLogin: gitLogin,
  GitHubLogin: gitHubLogin,
  CloudLogin: cloudLogin,
  Bash: bash,
} satisfies Registry
