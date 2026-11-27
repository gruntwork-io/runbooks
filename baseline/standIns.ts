/**
 * A registry with today's 22 tags. Each block the real registry has is its
 * entry here. Until it has them all, the rest stand in: each tag's class and
 * effects as the plan gives them ("The classes" and "Effects and
 * capabilities"), its props taken as written, since a stand-in lets a
 * runbook parse and checks what a step may say about a block, not the
 * block's props.
 */
import { Effect, Option, Schema, Stream } from "effect"
import {
  type Alias,
  defineCredential,
  defineDisplay,
  defineForm,
  defineTask,
  type MachineEffect,
} from "@runbooks/blocks-core/contract"
import type { Registry } from "@runbooks/blocks-core/registry"
import * as registry from "@runbooks/blocks"

/** Props as written: the stand-in takes any. */
const AnyProps = Schema.Record(Schema.String, Schema.Unknown)
type AnyProps = typeof AnyProps.Type

const base = (name: string) => ({
  name,
  since: "0.1.0",
  props: AnyProps,
  children: { kind: "markdown" } as const,
  references: {},
  runbookFiles: () => [],
})

/** An `outputs={["a", "b"]}` prop's names, each carrying the field of its name, as Iframe's do. */
const outputsProp = (p: AnyProps) =>
  Object.fromEntries(
    (Array.isArray(p.outputs) ? p.outputs : [])
      .filter((key): key is string => typeof key === "string")
      .map((key) => [key, { field: key }]),
  )

const noForm = { fields: [], sections: [] }

const display = (name: string) =>
  defineDisplay({ ...base(name), class: "display", provides: [], effects: [] })

const form = (name: string) =>
  defineForm({
    ...base(name),
    class: "form",
    provides: ["values"],
    effects: [],
    outputs: outputsProp,
    fields: () => Effect.succeed(noForm),
    plugins: [],
  })

const task = (
  name: string,
  effects: ReadonlyArray<MachineEffect>,
  options: { readonly fields?: boolean } = {},
) =>
  defineTask({
    ...base(name),
    class: "task",
    provides: ["run"],
    effects,
    outputs: () => ({}),
    ...(options.fields === true ? { fields: () => Effect.succeed(noForm) } : {}),
    run: () => Stream.empty,
    instruction: () => [],
    plugins: [],
  })

const credential = (name: string, scope: string) =>
  defineCredential({
    ...base(name),
    class: "credential",
    provides: ["env"],
    effects: ["network"],
    scope,
    provider: scope,
    envNames: [],
    outputs: () => ({}),
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

const alias = (name: string, of: string, locked: AnyProps): Alias<AnyProps> => ({
  name,
  since: "0.1.0",
  of,
  locked,
})

/**
 * Today's 22 tags. The plan: GitClone declares `push`, for an empty remote,
 * and GitPullRequest for its branch; Template has a form of its own, the
 * template's variables. ShowWhen came from main after the plan (#564): it
 * shows its content by another block's output and does nothing itself, so
 * it stands in as a display block.
 */
export const STAND_IN: Registry = {
  Admonition: display("Admonition"),
  Chapter: display("Chapter"),
  ShowWhen: display("ShowWhen"),
  Inputs: form("Inputs"),
  DirPicker: form("DirPicker"),
  Iframe: form("Iframe"),
  Command: task("Command", ["process"]),
  Check: task("Check", ["process"]),
  Finish: task("Finish", ["process"]),
  Prerequisites: task("Prerequisites", ["process"]),
  Template: task("Template", ["files"], { fields: true }),
  TemplateInline: task("TemplateInline", ["files"]),
  GitClone: task("GitClone", ["process", "network", "repository", "push"]),
  GitPullRequest: task("GitPullRequest", ["process", "network", "push"]),
  AwsAuth: credential("AwsAuth", "aws"),
  GoogleAuth: credential("GoogleAuth", "google"),
  AzureAuth: credential("AzureAuth", "azure"),
  GitAuth: credential("GitAuth", "git"),
  GitHubAuth: alias("GitHubAuth", "GitAuth", { provider: "github" }),
  GitLabAuth: alias("GitLabAuth", "GitAuth", { provider: "gitlab" }),
  GitHubPullRequest: alias("GitHubPullRequest", "GitPullRequest", { provider: "github" }),
  GitLabMergeRequest: alias("GitLabMergeRequest", "GitPullRequest", { provider: "gitlab" }),
}

/** The real registry's entries, and stand-ins for the tags it does not have yet. */
export const BLOCKS: Registry = { ...STAND_IN, ...registry }
