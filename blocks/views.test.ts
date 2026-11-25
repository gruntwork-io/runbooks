import { describe, expect, expectTypeOf, it } from "bun:test"
import { Schema, Stream } from "effect"
import { type Alias, defineDisplay, defineTask } from "@runbooks/blocks-core/contract"
import type { Registry } from "@runbooks/blocks-core/registry"
import { type View, type ViewRequest, views, type ViewsFor } from "./views.ts"

const NoteProps = Schema.Struct({ title: Schema.String })
const ShellProps = Schema.Struct({ shell: Schema.String })

const toy = {
  Note: defineDisplay({
    name: "Note",
    since: "0.31.0",
    class: "display",
    props: NoteProps,
    children: { kind: "markdown" },
    references: {},
    runbookFiles: () => [],
    provides: [],
    effects: [],
  }),
  Shell: defineTask({
    name: "Shell",
    since: "0.31.0",
    class: "task",
    props: ShellProps,
    children: { kind: "none" },
    references: {},
    runbookFiles: () => [],
    provides: ["run"],
    effects: ["process"],
    outputs: () => ({}),
    run: () => Stream.empty,
    instruction: () => [],
    plugins: [],
  }),
  Bash: {
    name: "Bash",
    since: "0.31.0",
    of: "Shell",
    locked: { shell: "bash" },
  } satisfies Alias<typeof ShellProps.Type>,
} satisfies Registry

type Views = ViewsFor<typeof toy>
type NoteView = View<typeof NoteProps.Type>
type ShellView = View<typeof ShellProps.Type>

describe("the view map's type", () => {
  it("needs a view for each display block, and takes one for any other block", () => {
    expectTypeOf<{ Note: NoteView }>().toExtend<Views>()
    expectTypeOf<{ Note: NoteView; Shell: ShellView }>().toExtend<Views>()
    expectTypeOf<{ Shell: ShellView }>().not.toExtend<Views>()
  })

  it("refuses a view whose props are not its block's", () => {
    expectTypeOf<{ Note: ShellView }>().not.toExtend<Views>()
  })

  it("has no slot for an alias or a tag the registry lacks", () => {
    expectTypeOf<keyof Views>().toEqualTypeOf<"Note" | "Shell">()
  })

  it("lets a view ask only for what the engine takes from a view", () => {
    expectTypeOf<ViewRequest["_tag"]>().toEqualTypeOf<
      "RunBlock" | "CancelBlock" | "ResetBlock" | "SetValues" | "ActOnCredential"
    >()
    expectTypeOf<{ _tag: "RunBlock" }>().toExtend<ViewRequest>()
    expectTypeOf<{ _tag: "SetValues" }>().not.toExtend<ViewRequest>()
  })
})

describe("the app's view map", () => {
  it("has no views while the registry has no blocks", () => {
    expect(views).toEqual({})
  })
})
