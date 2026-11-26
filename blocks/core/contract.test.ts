import { describe, expect, expectTypeOf, it } from "bun:test"
import { Context, Effect, Option, Result, Schema, Stream } from "effect"
import {
  BEFORE_TRUST,
  BlockClass,
  BlockId,
  type CredentialBlock,
  defineCredential,
  defineDisplay,
  defineForm,
  defineTask,
  endWithExitCode,
  type FormBlock,
  type PropError,
  type References,
  type TaskBlock,
  type TaskEvent,
  TaskFailed,
  type TaskInput,
  type TaskReads,
} from "./contract.ts"
import { FormSpec } from "./form.ts"
import { BlockStatus } from "./status.ts"

const NoProps = Schema.Struct({})
const none = { kind: "none" } as const

const UrlProps = Schema.Struct({
  url: Schema.String,
  dependsOn: Schema.optionalKey(BlockId),
  repository: Schema.optionalKey(BlockId),
  envFrom: Schema.optionalKey(Schema.Array(BlockId)),
})

describe("BlockId", () => {
  const decode = Schema.decodeUnknownSync(BlockId)

  it("is the same id with a hyphen or an underscore", () => {
    expect(decode("create-account")).toBe(decode("create_account"))
  })

  it("tells ids apart by case", () => {
    expect(decode("Deploy")).not.toBe(decode("deploy"))
  })

  it("normalizes an id inside a list, so a reference matches its target", () => {
    expect(Schema.decodeUnknownSync(Schema.Array(BlockId))(["a-b", "c"])).toEqual([
      decode("a_b"),
      decode("c"),
    ])
  })

  it("encodes to the form it compares by", () => {
    expect(Schema.encodeSync(BlockId)(decode("create-account"))).toBe("create_account")
  })

  it("refuses an empty id", () => {
    expect(() => decode("")).toThrow()
  })

  it.each(["../x", "x/.", ".", "a b", "a.b", "a/b", "\\x", "é"])(
    "refuses %p, which could name a folder outside its own or another's",
    (written) => {
      expect(() => decode(written)).toThrow("an id is letters, digits, `-` and `_`")
    },
  )
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
      envNames: ["CLOUD_TOKEN"],
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
      Pick<FormBlock<object>, "effects">
    >()
    expectTypeOf<{ effects: readonly [] }>().toExtend<Pick<FormBlock<object>, "effects">>()
  })

  it("a run that streams an output the block did not declare", () => {
    type Run = TaskBlock<object, "status", never>["run"]
    expectTypeOf<
      () => Stream.Stream<TaskEvent<"status" | "body">, never, never>
    >().not.toExtend<Run>()
    expectTypeOf<() => Stream.Stream<TaskEvent<"status">, never, never>>().toExtend<Run>()
  })

  it("a run that reads a path its task did not name", () => {
    const clone = defineTask({
      name: "Clone",
      since: "0.31.0",
      class: "task",
      props: UrlProps,
      children: none,
      references: {},
      runbookFiles: () => [],
      provides: ["run", "repository"],
      effects: ["repository"],
      outputs: () => ({}),
      paths: () => ({ target: { root: "working", path: "repo" } }),
      repository: "target",
      run: () => Stream.empty,
      instruction: (p) => [{ kind: "code", language: "bash", code: `git clone ${p.url} repo` }],
      plugins: [],
    })
    type Input = Parameters<typeof clone.run>[1]
    expectTypeOf<Input["paths"]>().toEqualTypeOf<{ readonly target: string }>()
    expectTypeOf<"elsewhere">().not.toExtend<keyof Input["paths"]>()
    expectTypeOf<"elsewhere">().not.toExtend<NonNullable<typeof clone.repository>>()
  })

  it("an instruction that reads what only a run's I/O makes", () => {
    // Instruction mode builds its input before trust, with no I/O: no
    // environment, no resolved paths, no repository, no credential.
    type Reads = Parameters<TaskBlock<object, never, never, "target">["instruction"]>[1]
    expectTypeOf<keyof Reads>().toEqualTypeOf<"values" | "outputs" | "files">()
    expectTypeOf<Reads>().toEqualTypeOf<TaskReads>()
    expectTypeOf<TaskInput<"target">>().toExtend<TaskReads>()
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

  it("a credential block that does not name the variables its provider sets", () => {
    type Declared = Pick<CredentialBlock<object>, "envNames">
    expectTypeOf<{ provider: "aws" }>().not.toExtend<Declared>()
    expectTypeOf<{ envNames: readonly ["AWS_ACCESS_KEY_ID"] }>().toExtend<Declared>()
  })

  it("a function allowed before trust that asks for a service", () => {
    class Disk extends Context.Service<Disk, { readonly read: Effect.Effect<string> }>()("Disk") {}
    type FormFields = FormBlock<object>["fields"]
    type TaskFields = NonNullable<TaskBlock<object, never, Disk>["fields"]>
    expectTypeOf<() => Effect.Effect<FormSpec, PropError, Disk>>().not.toExtend<FormFields>()
    expectTypeOf<() => Effect.Effect<FormSpec, PropError, Disk>>().not.toExtend<TaskFields>()
    expectTypeOf<() => Effect.Effect<FormSpec, PropError>>().toExtend<FormFields>()
    // A run gets the services its block asks for.
    expectTypeOf<() => Stream.Stream<TaskEvent<never>, never, Disk>>().toExtend<
      TaskBlock<object, never, Disk>["run"]
    >()
  })

  it("a reference declared on a prop that cannot name a block", () => {
    type Refs = References<typeof UrlProps.Type>
    expectTypeOf<keyof Refs>().toEqualTypeOf<"dependsOn" | "repository" | "envFrom">()
  })
})

describe("BEFORE_TRUST", () => {
  it("lets the engine call every function a block declares before trust, but run", () => {
    const afterTrust = Object.entries(BEFORE_TRUST).filter(([, allowed]) => !allowed)
    expect(afterTrust.map(([name]) => name)).toEqual(["run"])
  })
})

describe("the exit-code table", () => {
  const end = (exitCode: number) =>
    Effect.runPromise(Effect.result(Stream.runCollect(endWithExitCode(exitCode))))

  it("succeeds on 0, warns on 2 and fails on any other code, with the code", async () => {
    expect(await end(0)).toEqual(Result.succeed([]))
    const warned = await end(2)
    expect(Result.isSuccess(warned) && warned.success.map((e) => e._tag)).toEqual(["Warning"])
    for (const exitCode of [1, 3, 126, 127, 130, 255, -1]) {
      const failed = await end(exitCode)
      expect(Result.isFailure(failed) && failed.failure).toMatchObject({
        _tag: "TaskFailed",
        exitCode,
      })
    }
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

describe("BlockStatus", () => {
  it("round-trips a failed status through its encoded form", () => {
    const status: BlockStatus = {
      _tag: "Failed",
      error: new TaskFailed({ message: "exit 1", exitCode: 1 }),
    }
    const encoded = Schema.encodeSync(BlockStatus)(status)
    expect(JSON.parse(JSON.stringify(encoded))).toEqual({
      _tag: "Failed",
      error: { _tag: "TaskFailed", message: "exit 1", exitCode: 1 },
    })
    const decoded = Schema.decodeUnknownSync(BlockStatus)(JSON.parse(JSON.stringify(encoded)))
    expect(decoded._tag === "Failed" && decoded.error instanceof TaskFailed).toBe(true)
  })

  it("rejects a done block without an outcome", () => {
    expect(() => Schema.decodeUnknownSync(BlockStatus)({ _tag: "Done" })).toThrow()
  })
})
