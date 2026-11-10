import type { ReactNode } from "react"
import {
  isHiddenValue,
  type PropertyValue,
  type ResourceAction,
} from "../../../../../../src/domain/tofu-module/run"
import { childPath, isUnknown, keyText, type Leaf, type PropertyRow } from "../propertyRows"

/** How a resource's properties are laid out. */
export type PropertyLayout = "table" | "text"

export const LAYOUTS: { layout: PropertyLayout; label: string }[] = [
  { layout: "table", label: "Table" },
  { layout: "text", label: "Plan text" },
]

type Properties = Readonly<Record<string, PropertyValue>>

/** A path with all but its last part muted, so the eye lands on the name. */
function PathText({ path }: { path: string }) {
  const last = /(\[[^\]]*\]|[^.[\]]+)$/.exec(path)
  const cut = last ? last.index : 0
  return (
    <span className="break-all">
      <span className="text-muted-foreground/70">{path.slice(0, cut)}</span>
      <span className="text-foreground/80">{path.slice(cut)}</span>
    </span>
  )
}

/** A value, without quotes: a hidden one as what hides it, empty text as "(empty)". */
function LeafText({ value }: { value: Leaf | undefined }) {
  if (value === undefined) return <span className="text-muted-foreground">—</span>
  if (isHiddenValue(value)) {
    return <span className="italic text-muted-foreground">({value.hidden})</span>
  }
  if (value === "") return <span className="italic text-muted-foreground">(empty)</span>
  if (typeof value === "string") return <span className="break-all text-foreground">{value}</span>
  return <span className="text-primary">{JSON.stringify(value)}</span>
}

/** Values known now first, then the ones known only after apply. */
const knownFirst = (rows: readonly PropertyRow[]) => [
  ...rows.filter((r) => !isUnknown(r.after)),
  ...rows.filter((r) => isUnknown(r.after)),
]

/** One row per value, its full path in one column and its value in the next. */
function PropertyTable({ rows, hasBefore }: { rows: readonly PropertyRow[]; hasBefore: boolean }) {
  const cell = "border-b border-border/60 px-2 py-1"
  return (
    <div
      role="table"
      className="grid overflow-hidden rounded border-x border-t border-border/60 font-mono text-xs"
      style={{
        gridTemplateColumns: hasBefore ? "fit-content(40%) 1fr 1fr" : "fit-content(45%) 1fr",
      }}
    >
      {hasBefore && (
        <div role="row" className="contents">
          {["Property", "Before", "After"].map((h) => (
            <div
              key={h}
              role="columnheader"
              className={`${cell} bg-muted/50 font-sans font-medium text-muted-foreground`}
            >
              {h}
            </div>
          ))}
        </div>
      )}
      {knownFirst(rows).map((row) => {
        const tone = hasBefore && row.changed ? "bg-warning-muted/50" : ""
        return (
          <div key={row.path} role="row" className="contents">
            <div role="cell" className={`${cell} ${tone}`}>
              <PathText path={row.path} />
            </div>
            {hasBefore && (
              <div role="cell" className={`${cell} ${tone}`}>
                <span className={row.changed ? "line-through decoration-muted-foreground/60" : ""}>
                  <LeafText value={row.before} />
                </span>
              </div>
            )}
            <div role="cell" className={`${cell} ${tone}`}>
              <LeafText value={row.after} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

type Sign = "+" | "-" | "~" | " "

interface Line {
  readonly depth: number
  readonly sign: Sign
  readonly content: ReactNode
  /** Whether the line is context the change doesn't touch. */
  readonly quiet?: boolean
}

const SIGN_CLASS: Record<Sign, string> = {
  "+": "text-success",
  "-": "text-destructive",
  "~": "text-warning-foreground",
  " ": "",
}

const isContainer = (v: PropertyValue | undefined): v is Properties | readonly PropertyValue[] =>
  v !== null && v !== undefined && typeof v === "object" && !isHiddenValue(v)

const asMap = (v: PropertyValue | undefined) =>
  isContainer(v) && !Array.isArray(v) ? (v as Properties) : undefined

const asList = (v: PropertyValue | undefined) =>
  Array.isArray(v) ? (v as readonly PropertyValue[]) : undefined

/** A leaf as HCL writes it. */
function hclLeaf(value: Leaf): ReactNode {
  if (isHiddenValue(value)) {
    return (
      <span className="italic text-muted-foreground">
        ({value.hidden === "sensitive" ? "sensitive value" : value.hidden})
      </span>
    )
  }
  return <span className="text-foreground">{JSON.stringify(value)}</span>
}

/**
 * The plan as OpenTofu prints it: `+` for what it adds, `~` for what it
 * changes, `-` for what it removes, with only the values the filter keeps.
 */
function planLines(
  after: Properties,
  before: Properties | undefined,
  keep: ReadonlySet<string>,
): Line[] {
  const hasBefore = before !== undefined
  const leafSign = (a: Leaf | undefined, b: Leaf | undefined): Sign => {
    if (!hasBefore || b === undefined) return "+"
    if (a === undefined) return "-"
    return JSON.stringify(a) === JSON.stringify(b) ? " " : "~"
  }
  const blockSign = (
    a: PropertyValue | undefined,
    b: PropertyValue | undefined,
    inner: Line[],
  ): Sign => {
    if (!hasBefore || b === undefined) return "+"
    if (a === undefined) return "-"
    return inner.some((l) => l.sign !== " ") ? "~" : " "
  }

  const entries = (
    a: Properties | undefined,
    b: Properties | undefined,
    path: string,
    depth: number,
  ): Line[] => {
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
    const leafKeys = keys.filter(
      (k) => !isContainer(a?.[k]) && !isContainer(b?.[k]) && keep.has(childPath(path, k)),
    )
    const width = Math.max(0, ...leafKeys.map((k) => keyText(k).length))
    return keys.flatMap((k) => value(keyText(k), a?.[k], b?.[k], childPath(path, k), depth, width))
  }

  const value = (
    label: string,
    a: PropertyValue | undefined,
    b: PropertyValue | undefined,
    path: string,
    depth: number,
    width: number,
    suffix = "",
  ): Line[] => {
    if (!isContainer(a) && !isContainer(b)) {
      if (!keep.has(path)) return []
      const sign = leafSign(a, b)
      const shown =
        sign === "~" ? (
          <>
            {hclLeaf(b as Leaf)} <span className="text-muted-foreground">→</span>{" "}
            {hclLeaf(a as Leaf)}
          </>
        ) : (
          hclLeaf((a ?? b) as Leaf)
        )
      return [
        {
          depth,
          sign,
          quiet: sign === " ",
          content: (
            <>
              {label && <span className="text-muted-foreground">{label.padEnd(width)} = </span>}
              {shown}
              {suffix}
            </>
          ),
        },
      ]
    }
    const listA = asList(a)
    const listB = asList(b)
    if (listA || listB) {
      const length = Math.max(listA?.length ?? 0, listB?.length ?? 0)
      const items = [...(listA ?? []), ...(listB ?? [])]
      if (items.some((item) => asMap(item))) {
        // A list of objects reads as repeated blocks, as HCL writes them.
        return Array.from({ length }, (_, i) => {
          const inner = entries(asMap(listA?.[i]), asMap(listB?.[i]), childPath(path, i), depth + 1)
          if (inner.length === 0) return []
          const sign = blockSign(listA?.[i], listB?.[i], inner)
          const quiet = sign === " "
          return [
            {
              depth,
              sign,
              quiet,
              content: (
                <span className="text-muted-foreground">
                  {label} {"{"}
                </span>
              ),
            },
            ...inner,
            {
              depth,
              sign: " " as Sign,
              quiet,
              content: <span className="text-muted-foreground">{"}"}</span>,
            },
          ]
        }).flat()
      }
      const inner = Array.from({ length }, (_, i) =>
        value("", listA?.[i], listB?.[i], childPath(path, i), depth + 1, 0, ","),
      ).flat()
      if (inner.length === 0) return []
      const sign = blockSign(a, b, inner)
      return [
        {
          depth,
          sign,
          quiet: sign === " ",
          content: <span className="text-muted-foreground">{label} = [</span>,
        },
        ...inner,
        {
          depth,
          sign: " ",
          quiet: sign === " ",
          content: <span className="text-muted-foreground">]</span>,
        },
      ]
    }
    const inner = entries(asMap(a), asMap(b), path, depth + 1)
    if (inner.length === 0) return []
    const sign = blockSign(a, b, inner)
    return [
      {
        depth,
        sign,
        quiet: sign === " ",
        content: (
          <span className="text-muted-foreground">
            {label} = {"{"}
          </span>
        ),
      },
      ...inner,
      {
        depth,
        sign: " ",
        quiet: sign === " ",
        content: <span className="text-muted-foreground">{"}"}</span>,
      },
    ]
  }

  return entries(after, before, "", 0)
}

/** The plan as OpenTofu prints it. */
function PropertyPlanText({
  after,
  before,
  rows,
}: {
  after: Properties
  before?: Properties | undefined
  rows: readonly PropertyRow[]
}) {
  const lines = planLines(after, before, new Set(rows.map((r) => r.path)))
  return (
    <pre className="overflow-x-auto font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={`flex ${line.quiet ? "opacity-60" : ""}`}>
          <span className={`w-4 shrink-0 select-none ${SIGN_CLASS[line.sign]}`}>{line.sign}</span>
          <span style={{ paddingLeft: `${line.depth * 2}ch` }}>{line.content}</span>
        </div>
      ))}
    </pre>
  )
}

interface PropertyViewProps {
  layout: PropertyLayout
  /** The rows the filter keeps. */
  rows: readonly PropertyRow[]
  after: Properties
  before?: Properties | undefined
  action?: ResourceAction | undefined
}

/** A resource's properties, in the layout the person picked. */
export function PropertyView({ layout, rows, after, before, action }: PropertyViewProps) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No properties match.</p>
  }
  // A resource the plan deletes has only what it was, so that's what the columns show.
  const deleted = action === "delete"
  const shown = deleted ? rows.map((r) => ({ ...r, after: r.before, changed: false })) : rows
  const hasBefore = before !== undefined && !deleted
  switch (layout) {
    case "table":
      return <PropertyTable rows={shown} hasBefore={hasBefore} />
    case "text":
      return <PropertyPlanText after={after} before={before} rows={rows} />
  }
}
