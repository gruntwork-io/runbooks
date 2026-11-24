import { describe, expect, expectTypeOf, it } from "bun:test"
import { Effect, Option, Schema, Stream } from "effect"
import {
  BlockClass,
  BlockId,
  type CredentialBlock,
  defineCredential,
  defineDisplay,
  defineForm,
  defineTask,
  type FormBlock,
  type References,
  type TaskBlock,
  type TaskEvent,
} from "./contract.ts"
import { FormSpec } from "./form.ts"

const NoProps = Schema.Struct({})
const none = { kind: "none" } as const

const UrlProps = Schema.Struct({
  url: Schema.String,
  dependsOn: Schema.optionalKey(BlockId),
  repository: Schema.optionalKey(BlockId),
  envFrom: Schema.optionalKey(Schema.Array(BlockId)),
})

describe("block definitions", () => {
  it("accepts one block of each class", () => {
    const note = defineDisplay({
      name: "Note",
      since: "0.31.0",
      class: "display",
      props: NoProps,
      children: { kind: "markdown" },
      references: {},
      runbookFiles: () => [],
      provides: [],
      effects: [],
    })
    const form = defineForm({
      name: "Form",
      since: "0.31.0",
      class: "form",
      props: NoProps,
      children: none,
      references: {},
      runbookFiles: () => [],
      provides: ["values"],
      effects: [],
      outputs: () => ({}),
      fields: () => Effect.succeed({ fields: [], sections: [] }),
      plugins: [],
    })
    const task = defineTask({
      name: "Fetch",
      since: "0.31.0",
      class: "task",
      props: UrlProps,
      children: none,
      references: { repository: "repository" },
      runbookFiles: () => [],
      provides: ["run"],
      effects: ["network"],
      outputs: () => ({ status: { sensitive: false } }),
      run: () => Stream.make({ _tag: "Output", key: "status", value: "200" } as const),
      instruction: (p) => [{ kind: "link", label: "Open", url: p.url }],
      plugins: [],
    })
    const credential = defineCredential({
      name: "Cloud",
      since: "0.31.0",
      class: "credential",
      props: NoProps,
      children: none,
      references: {},
      runbookFiles: () => [],
      provides: ["env"],
      effects: ["network", "browser"],
      scope: "cloud",
      provider: "fake",
      outputs: () => ({ account: { sensitive: false } }),
      request: () => ({
        detect: [{ kind: "env", prefix: Option.none() }],
        pins: {},
        requirements: [],
        settings: {},
        defaultMethod: Option.none(),
        methodDefaults: {},
      }),
      instruction: () => [],
    })
    expect([note.class, form.class, task.class, credential.class]).toEqual([
      "display",
      "form",
      "task",
      "credential",
    ])
  })
})

describe("what the compiler rejects", () => {
  it("a form block that declares a machine effect", () => {
    expectTypeOf<{ effects: readonly ["process"] }>().not.toExtend<
      Pick<FormBlock<object, never>, "effects">
    >()
    expectTypeOf<{ effects: readonly [] }>().toExtend<Pick<FormBlock<object, never>, "effects">>()
  })

  it("a run that streams an output the block did not declare", () => {
    type Run = TaskBlock<object, "status", never>["run"]
    expectTypeOf<
      () => Stream.Stream<TaskEvent<"status" | "body">, never, never>
    >().not.toExtend<Run>()
    expectTypeOf<() => Stream.Stream<TaskEvent<"status">, never, never>>().toExtend<Run>()
  })

  it("a task that does not provide run, and a display block that provides anything", () => {
    type TaskProvides = TaskBlock<object, never, never>["provides"]
    expectTypeOf<readonly ["values"]>().not.toExtend<TaskProvides>()
    expectTypeOf<readonly ["run", "values", "env"]>().toExtend<TaskProvides>()
    expectTypeOf<readonly ["values"]>().not.toExtend<
      ReturnType<typeof defineDisplay<object>>["provides"]
    >()
  })

  it("a credential block that does not provide env", () => {
    type Provides = CredentialBlock<object>["provides"]
    expectTypeOf<readonly ["git-credential"]>().not.toExtend<Provides>()
    expectTypeOf<readonly ["env", "git-credential"]>().toExtend<Provides>()
  })

  it("a reference declared on a prop that cannot name a block", () => {
    type Refs = References<typeof UrlProps.Type>
    expectTypeOf<keyof Refs>().toEqualTypeOf<"dependsOn" | "repository" | "envFrom">()
  })
})

describe("closed sets", () => {
  it("decode only their members", () => {
    expect(Schema.decodeUnknownSync(BlockClass)("task")).toBe("task")
    expect(() => Schema.decodeUnknownSync(BlockClass)("workspace")).toThrow()
    expectTypeOf<BlockClass>().toEqualTypeOf<"display" | "form" | "task" | "credential">()
  })
})

describe("FormSpec", () => {
  it("decodes a field and rejects an unknown type", () => {
    const field = {
      name: "Region",
      type: "enum",
      description: "Where to deploy",
      default: "us-east-1",
      required: true,
      options: ["us-east-1", "eu-west-1"],
      validations: [{ kind: "required" }],
      sensitive: false,
      locked: false,
      hidden: false,
    }
    const spec = Schema.decodeUnknownSync(FormSpec)({ fields: [field], sections: [] })
    expect(spec.fields[0]?.options).toEqual(["us-east-1", "eu-west-1"])
    expect(() =>
      Schema.decodeUnknownSync(FormSpec)({ fields: [{ ...field, type: "date" }], sections: [] }),
    ).toThrow()
  })
})
