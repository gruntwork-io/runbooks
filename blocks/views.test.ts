import { describe, expect, expectTypeOf, it } from "bun:test"
import { Schema, Stream } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { type Alias, defineDisplay, defineTask } from "@runbooks/blocks-core/contract"
import { isAlias, type Registry } from "@runbooks/blocks-core/registry"
import * as registry from "./index.ts"
import { type View, type ViewRequest, views, type ViewsFor, viewsFromJson } from "./views.ts"

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

describe("a view map drawing from the props the engine sends", () => {
  /** A display block whose props the engine sends encoded: `count` as a string. */
  const CountProps = Schema.Struct({ count: Schema.NumberFromString })
  const counted = {
    Count: defineDisplay({
      name: "Count",
      since: "0.31.0",
      class: "display",
      props: CountProps,
      children: { kind: "markdown" },
      references: {},
      runbookFiles: () => [],
      provides: [],
      effects: [],
    }),
  } satisfies Registry
  /** Count's view, drawing one more than its decoded count. */
  const CountView: View<typeof CountProps.Type> = ({ props, status, children }) =>
    createElement("p", null, `${props.count + 1} ${status?._tag ?? "no status"}`, children)
  const drawn = (props: Schema.Json) => {
    const Drawn = viewsFromJson(counted, { Count: CountView }).Count
    if (Drawn === undefined) throw new Error("no view for Count")
    return renderToStaticMarkup(
      createElement(
        Drawn,
        { props, status: undefined, act: () => {}, hidden: { has: () => false, hide: () => {} } },
        "Its markdown.",
      ),
    )
  }

  it("gives each view its block's props decoded with its block's own schema", () => {
    expect(drawn({ count: "7" })).toBe("<p>8 no statusIts markdown.</p>")
  })

  it("draws a line that says so for props its block's schema does not decode", () => {
    expect(drawn({ count: 7 })).toBe(
      '<p class="block-no-view">The window can&#x27;t read the props of &lt;Count&gt;.</p>',
    )
  })

  it("keeps a view only for a tag that names a block in the registry, not an alias's", () => {
    const aliased = {
      ...counted,
      Tally: { name: "Tally", since: "0.31.0", of: "Count", locked: {} },
    } satisfies Registry
    const loose = { Count: CountView, Tally: CountView, Missing: CountView } as unknown as ViewsFor<
      typeof aliased
    >
    expect(Object.keys(viewsFromJson(aliased, loose))).toEqual(["Count"])
  })
})

describe("the app's view map", () => {
  it("has a view for each display block in the registry", () => {
    const display = Object.entries(registry as Registry).flatMap(([tag, entry]) =>
      !isAlias(entry) && entry.class === "display" ? [tag] : [],
    )
    expect(display.length).toBeGreaterThan(0)
    expect(Object.keys(views).sort()).toEqual(display.sort())
  })
})
