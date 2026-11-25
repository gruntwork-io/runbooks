/**
 * A registry of toy blocks, one per kind of thing the parser and the graph
 * must handle, for tests that need blocks before phase 3 adds real ones.
 * The tags are today's, so ported tests read as they did.
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
import type { Registry } from "@runbooks/blocks-core/registry"

const toPath = Schema.decodeSync(RunbookPath)

/** Display, markdown children, its own `title` and `description`, which are shared props too. */
const admonition = defineDisplay({
  name: "Admonition",
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

const CommandProps = Schema.Struct({
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
const command = defineTask({
  name: "Command",
  since: "0.1.0",
  class: "task",
  props: CommandProps,
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

/** Form whose fields come from fenced YAML children. */
const inputs = defineForm({
  name: "Inputs",
  since: "0.1.0",
  class: "form",
  props: Schema.Struct({
    variables: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
  }),
  children: { kind: "yaml", prop: "variables" },
  references: {},
  runbookFiles: () => [],
  provides: ["values"],
  effects: [],
  outputs: (p) => Object.fromEntries(p.variables.map((v) => [v.name, { sensitive: false }])),
  fields: () => Effect.succeed({ fields: [], sections: [] }),
  plugins: [],
})

/** Task that names a form by a reference prop of its own. */
const clone = defineTask({
  name: "GitClone",
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

const GitAuthProps = Schema.Struct({
  provider: Schema.optionalKey(Schema.Literals(["github", "gitlab"])),
})

/** Credential: gives environment, and a git credential to blocks that name it in `gitAuthId`. */
const gitAuth = defineCredential({
  name: "GitAuth",
  since: "0.1.0",
  class: "credential",
  props: GitAuthProps,
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

const gitHubAuth: Alias<typeof GitAuthProps.Type> = {
  name: "GitHubAuth",
  since: "0.1.0",
  of: "GitAuth",
  locked: { provider: "github" },
}

const bash: Alias<typeof CommandProps.Type> = {
  name: "Bash",
  since: "0.2.0",
  of: "Command",
  locked: { shell: "bash" },
}

export const TOY_REGISTRY = {
  Admonition: admonition,
  Command: command,
  Inputs: inputs,
  GitClone: clone,
  GitAuth: gitAuth,
  GitHubAuth: gitHubAuth,
  Bash: bash,
} satisfies Registry
