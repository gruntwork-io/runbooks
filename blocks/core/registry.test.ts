import { describe, expect, expectTypeOf, it } from "bun:test"
import { Context, Effect, Schema, Stream } from "effect"
import { type Alias, defineDisplay, defineTask } from "./contract.ts"
import {
  type BlockTags,
  type PropsOf,
  type Registry,
  registryProblems,
  resolveTag,
  type ServicesOf,
  type TagsOfClass,
} from "./registry.ts"

class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("Clock") {}

const none = { kind: "none" } as const

const note = defineDisplay({
  name: "Note",
  since: "0.31.0",
  class: "display",
  props: Schema.Struct({ title: Schema.String }),
  children: { kind: "markdown" },
  references: {},
  runbookFiles: () => [],
  provides: [],
  effects: [],
})

const ShellProps = Schema.Struct({ shell: Schema.String, command: Schema.String })

const shell = defineTask({
  name: "Shell",
  since: "0.31.0",
  class: "task",
  props: ShellProps,
  children: none,
  references: {},
  runbookFiles: () => [],
  provides: ["run"],
  effects: ["process"],
  outputs: () => ({ at: { sensitive: false } }),
  run: () =>
    Stream.fromEffect(
      Effect.gen(function* () {
        const now = yield* (yield* Clock).now
        return { _tag: "Output", key: "at", value: String(now) } as const
      }),
    ),
  instruction: (p) => [{ kind: "code", language: p.shell, code: p.command }],
  plugins: [],
})

const bash: Alias<typeof ShellProps.Type> = {
  name: "Bash",
  since: "0.31.0",
  of: "Shell",
  locked: { shell: "bash" },
}

const toy = { Note: note, Shell: shell, Bash: bash } satisfies Registry
type Toy = typeof toy

describe("the registry's types", () => {
  it("give each tag's props, through an alias too", () => {
    expectTypeOf<PropsOf<Toy["Note"]>>().toEqualTypeOf<{ readonly title: string }>()
    expectTypeOf<PropsOf<Toy["Bash"]>>().toEqualTypeOf<typeof ShellProps.Type>()
  })

  it("tell blocks from aliases, and blocks by class", () => {
    expectTypeOf<BlockTags<Toy>>().toEqualTypeOf<"Note" | "Shell">()
    expectTypeOf<TagsOfClass<Toy, "display">>().toEqualTypeOf<"Note">()
    expectTypeOf<TagsOfClass<Toy, "task">>().toEqualTypeOf<"Shell">()
  })

  it("collect the services the blocks need", () => {
    expectTypeOf<ServicesOf<Toy>>().toEqualTypeOf<Clock>()
  })
})

describe("resolveTag", () => {
  it("finds a block by its tag", () => {
    expect(resolveTag(toy, "Shell")).toEqual({ tag: "Shell", block: shell, locked: {} })
  })

  it("finds an alias's block, with the props it locks", () => {
    expect(resolveTag(toy, "Bash")).toEqual({
      tag: "Bash",
      block: shell,
      locked: { shell: "bash" },
    })
  })

  it("knows no tag outside the registry, inherited ones included", () => {
    expect(resolveTag(toy, "Missing")).toBeUndefined()
    expect(resolveTag(toy, "toString")).toBeUndefined()
  })
})

describe("registryProblems", () => {
  it("finds none in a sound registry", () => {
    expect(registryProblems(toy)).toEqual([])
  })

  it("names an entry filed under another tag, a bad tag or version, and a broken alias", () => {
    const broken = {
      Shell: shell,
      Note: { ...note, name: "Notice" },
      lower: { ...note, name: "lower" },
      Old: { ...note, name: "Old", since: "next" },
      Zsh: { ...bash, name: "Zsh", of: "Missing" },
      Sh: { ...bash, name: "Sh", of: "Zsh" },
    } satisfies Registry
    expect(registryProblems(broken)).toEqual([
      "Note: its entry is named Notice",
      "lower: a tag is PascalCase",
      "Old: since next is not a version",
      "Zsh: aliases Missing, which is not in the registry",
      "Sh: aliases Zsh, which is an alias",
    ])
  })
})
