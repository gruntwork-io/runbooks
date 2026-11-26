/**
 * The walk: a runbook's markdown, as the engine parsed it
 * (`DocumentView.tree`), rendered with React. The tree is the author's, so
 * the walk renders it as data:
 *
 * - Every element the page creates is named here. Nothing in the tree is
 *   parsed as HTML or run: an `html` node is its text.
 * - An HTML element the author wrote (`<div>`, `<kbd>`) is created only when
 *   `ELEMENTS` names it, with only the props `PROPS` names. React sets a
 *   `style` object through the CSSOM, which the CSP's `style-src` leaves
 *   alone. Any other element is its children.
 * - A link is clickable only to an http, https or mailto URL, or to a `#`
 *   fragment in the document (`linkTarget`). Any other shows its text and
 *   its URL.
 * - An image, and an `<img>`, `<video>`, `<audio>` or `<source>`, whose URL
 *   names a file in the runbook's assets/ folder (`assetUrl`) is created with
 *   that file's `runbook-asset:` URL, which main serves through its path
 *   guard, and only the props `MEDIA_PROPS` names. Any other shows its alt
 *   text and URL as text, and loads nothing: a remote URL, a path outside
 *   assets/, a `data:` or `file:` URL.
 * - A node of a type the walk doesn't know, or an element it doesn't create,
 *   shows its children, or its text value; `unknownParts` counts them for
 *   the page to say so.
 * - A block node is its placeholder (`block.tsx`), its markdown children
 *   inside it.
 */
import { Option, Schema } from "effect"
import { createElement, Fragment, type ReactNode } from "react"
import type { DocumentView } from "@runbooks/core/protocol"
import { BlockPlaceholder } from "./block.tsx"

type TreeNode = DocumentView["tree"]

const Text = Schema.optionalKey(Schema.NullOr(Schema.String))
const Flag = Schema.optionalKey(Schema.NullOr(Schema.Boolean))

/** The mdast nodes, and the parser's elements and blocks, as the walk reads them. Their children are the tree's own. */
const Part = Schema.Union([
  Schema.Struct({
    type: Schema.Literals([
      "root",
      "paragraph",
      "blockquote",
      "emphasis",
      "strong",
      "delete",
      "thematicBreak",
      "break",
      "tableRow",
      "tableCell",
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("heading"), depth: Schema.Literals([1, 2, 3, 4, 5, 6]) }),
  Schema.Struct({
    type: Schema.Literal("list"),
    ordered: Flag,
    start: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    spread: Flag,
  }),
  Schema.Struct({ type: Schema.Literal("listItem"), checked: Flag, spread: Flag }),
  Schema.Struct({ type: Schema.Literals(["text", "inlineCode", "html"]), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("code"), value: Schema.String, lang: Text }),
  Schema.Struct({ type: Schema.Literal("link"), url: Schema.String, title: Text }),
  Schema.Struct({ type: Schema.Literal("image"), url: Schema.String, alt: Text }),
  Schema.Struct({ type: Schema.Literal("linkReference"), identifier: Schema.String }),
  Schema.Struct({ type: Schema.Literal("imageReference"), identifier: Schema.String, alt: Text }),
  Schema.Struct({
    type: Schema.Literal("definition"),
    identifier: Schema.String,
    url: Schema.String,
    title: Text,
  }),
  Schema.Struct({
    type: Schema.Literals(["footnoteReference", "footnoteDefinition"]),
    identifier: Schema.String,
    label: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("table"),
    align: Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Literals(["left", "right", "center"])))),
    ),
  }),
  Schema.Struct({
    type: Schema.Literals(["mdxJsxFlowElement", "mdxJsxTextElement"]),
    name: Schema.String,
    props: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("block"), index: Schema.Int }),
])
type Part = typeof Part.Type
const decodePart = Schema.decodeUnknownOption(Part)

/** HTML elements the walk creates as written, with the props `PROPS` allows. */
const ELEMENTS: ReadonlySet<string> = new Set(
  [
    "div span p br hr blockquote pre code kbd samp var",
    "h1 h2 h3 h4 h5 h6 ul ol li dl dt dd",
    "table caption thead tbody tfoot tr th td",
    "details summary figure figcaption section article aside",
    "b strong i em u s del ins mark small sub sup abbr cite q dfn time",
  ].flatMap((line) => line.split(" ")),
)

/** Elements that take no children. */
const VOID: ReadonlySet<string> = new Set(["br", "hr"])

/** Elements that load a file: created for a runbook asset, else shown as their kind and URL. */
const MEDIA: ReadonlyMap<string, string> = new Map([
  ["img", "Image"],
  ["video", "Video"],
  ["audio", "Audio"],
  ["source", "Media"],
])

/**
 * The props a media element keeps besides its `src`, by the name as written,
 * lowercased, to the name React takes. A video's `poster` is kept when it
 * names an asset too. No element keeps `autoplay`, a handler or a style.
 */
const MEDIA_PROPS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "img",
    new Map([
      ["alt", "alt"],
      ["width", "width"],
      ["height", "height"],
    ]),
  ],
  [
    "video",
    new Map([
      ["controls", "controls"],
      ["preload", "preload"],
      ["muted", "muted"],
      ["loop", "loop"],
      ["width", "width"],
      ["height", "height"],
    ]),
  ],
  [
    "audio",
    new Map([
      ["controls", "controls"],
      ["preload", "preload"],
      ["muted", "muted"],
      ["loop", "loop"],
    ]),
  ],
  ["source", new Map()],
])

/** The scheme main serves the open runbook's assets/ from (packages/app-main/src/runbookAssets.ts). */
const ASSET_SCHEME = "runbook-asset"

/** How a URL that names a file in the runbook's assets/ folder starts. */
const IN_ASSETS = /^(?:\.\/)?assets\//

/**
 * The `runbook-asset:` URL of the file `url` names in the assets/ folder of
 * the runbook that `session` has open, or undefined when it names none.
 * `./assets/a.png` and `assets/a.png` name assets/a.png. A path that,
 * percent-decoded, has an empty, `.` or `..` part or a backslash names
 * none, and so does one the URL parser would read as another path (it
 * drops a tab or a newline, and trailing spaces), so the URL names the file
 * as written. Its host is the session's id, and its query or fragment is
 * kept.
 */
export function assetUrl(url: string, session: string): string | undefined {
  const prefix = IN_ASSETS.exec(url)
  if (prefix === null) return undefined
  const rest = url.slice(prefix[0].length)
  const asset = `${ASSET_SCHEME}://${session}/${rest}`
  let decoded: string
  let parsed: string
  try {
    decoded = decodeURIComponent(rest.split(/[?#]/, 1)[0] ?? "")
    parsed = decodeURIComponent(URL.parse(asset)?.pathname ?? "")
  } catch {
    return undefined
  }
  if (decoded.includes("\\") || parsed !== `/${decoded}`) return undefined
  if (decoded.split("/").some((part) => part === "" || part === "." || part === ".."))
    return undefined
  return asset
}

/** The elements the walk shows as more than their children. */
const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([...ELEMENTS, ...MEDIA.keys(), "a"])

/** The props an element keeps, by the name as written, lowercased, to the name React takes. */
const PROPS: ReadonlyMap<string, string> = new Map([
  ["title", "title"],
  ["style", "style"],
])
const ELEMENT_PROPS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ["details", new Map([["open", "open"]])],
  ["ol", new Map([["start", "start"]])],
  [
    "td",
    new Map([
      ["colspan", "colSpan"],
      ["rowspan", "rowSpan"],
    ]),
  ],
  [
    "th",
    new Map([
      ["colspan", "colSpan"],
      ["rowspan", "rowSpan"],
    ]),
  ],
])

const Style = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))
const decodeStyle = Schema.decodeUnknownOption(Style)

/** A part, or what the walk doesn't know, by the label `unknownParts` counts it under. */
type Read = Part | { readonly type: "unknown"; readonly label: string }

function read(tree: TreeNode): Read {
  const part = decodePart(tree)
  if (Option.isNone(part)) return { type: "unknown", label: tree.type }
  const { value } = part
  if (
    (value.type === "mdxJsxFlowElement" || value.type === "mdxJsxTextElement") &&
    !KNOWN_ELEMENTS.has(value.name)
  )
    return { type: "unknown", label: `<${value.name}>` }
  return value
}

/** The URL a link may open: an http, https or mailto URL, or a `#` fragment in the document. */
export function linkTarget(url: string): string | undefined {
  if (url.startsWith("#")) return url
  const parsed = URL.parse(url)
  if (parsed === null) return undefined
  return parsed.protocol === "http:" ||
    parsed.protocol === "https:" ||
    parsed.protocol === "mailto:"
    ? parsed.href
    : undefined
}

/** How many of each part the walk doesn't know `tree` holds, in the order first met. */
export function unknownParts(tree: TreeNode): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: TreeNode) => {
    const part = read(node)
    if (part.type === "unknown") counts.set(part.label, (counts.get(part.label) ?? 0) + 1)
    node.children?.forEach(visit)
  }
  visit(tree)
  return counts
}

/** Where a reference link goes. */
interface Definition {
  readonly url: string
  readonly title?: string | null
}

/** What the walk carries down the tree. */
interface Walk {
  readonly blocks: DocumentView["blocks"]
  /** Link definitions, by identifier, for references. */
  readonly definitions: ReadonlyMap<string, Definition>
  /** The runbook file, which a block's errors are located in. */
  readonly runbook: string
  /** The id of the session that has the runbook open: the host of its assets' URLs. */
  readonly session: string
}

function definitionsIn(tree: TreeNode): Walk["definitions"] {
  const found = new Map<string, Definition>()
  const visit = (node: TreeNode) => {
    const part = read(node)
    if (part.type === "definition" && !found.has(part.identifier)) found.set(part.identifier, part)
    node.children?.forEach(visit)
  }
  visit(tree)
  return found
}

/** A runbook's markdown: `document.tree`, its blocks as placeholders. */
export function Markdown({
  document,
  runbook,
  session,
}: {
  readonly document: Pick<DocumentView, "tree" | "blocks">
  /** The runbook file. */
  readonly runbook: string
  /** The id of the session that has it open. */
  readonly session: string
}) {
  const walk: Walk = {
    blocks: document.blocks,
    definitions: definitionsIn(document.tree),
    runbook,
    session,
  }
  return render(document.tree, 0, walk)
}

function children(tree: TreeNode, walk: Walk): ReactNode[] {
  return (tree.children ?? []).map((child, index) => render(child, index, walk))
}

function render(tree: TreeNode, key: number, walk: Walk): ReactNode {
  const part = read(tree)
  switch (part.type) {
    case "root":
    case "tableRow":
    case "tableCell":
      return <Fragment key={key}>{children(tree, walk)}</Fragment>
    case "paragraph":
      return <p key={key}>{children(tree, walk)}</p>
    case "heading":
      return createElement(`h${part.depth}`, { key }, children(tree, walk))
    case "blockquote":
      return <blockquote key={key}>{children(tree, walk)}</blockquote>
    case "emphasis":
      return <em key={key}>{children(tree, walk)}</em>
    case "strong":
      return <strong key={key}>{children(tree, walk)}</strong>
    case "delete":
      return <del key={key}>{children(tree, walk)}</del>
    case "thematicBreak":
      return <hr key={key} />
    case "break":
      return <br key={key} />
    case "text":
    case "html":
      return <Fragment key={key}>{part.value}</Fragment>
    case "inlineCode":
      return <code key={key}>{part.value}</code>
    case "code":
      return (
        <pre key={key}>
          <code data-language={part.lang ?? undefined}>{part.value}</code>
        </pre>
      )
    case "list":
      return list(tree, part, key, walk)
    case "listItem":
      return listItem(tree, part, key, false, walk)
    case "table":
      return table(tree, part, key, walk)
    case "link":
      return link(part.url, part.title, children(tree, walk), key)
    case "linkReference": {
      const definition = walk.definitions.get(part.identifier)
      return definition === undefined ? (
        <Fragment key={key}>{children(tree, walk)}</Fragment>
      ) : (
        link(definition.url, definition.title, children(tree, walk), key)
      )
    }
    case "image":
      return image(part.alt, part.url, key, walk)
    case "imageReference":
      return image(part.alt, walk.definitions.get(part.identifier)?.url ?? "", key, walk)
    case "definition":
      return null
    case "footnoteReference":
      return (
        <sup key={key}>
          <a href={`#${footnoteId(part.identifier)}`}>{part.label ?? part.identifier}</a>
        </sup>
      )
    case "footnoteDefinition":
      return (
        <div key={key} className="footnote" id={footnoteId(part.identifier)}>
          <sup>{part.label ?? part.identifier}</sup>
          {children(tree, walk)}
        </div>
      )
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return element(tree, part.name, part.props, key, walk)
    case "block": {
      const block = walk.blocks[part.index]
      if (block === undefined) return <Fragment key={key}>{children(tree, walk)}</Fragment>
      return (
        <BlockPlaceholder key={key} block={block} runbook={walk.runbook}>
          {children(tree, walk)}
        </BlockPlaceholder>
      )
    }
    case "unknown":
      return (
        <Fragment key={key}>
          {tree.children !== undefined
            ? children(tree, walk)
            : typeof tree["value"] === "string"
              ? tree["value"]
              : null}
        </Fragment>
      )
    default: {
      const unhandled: never = part
      throw new Error(`The walk has no case for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** A footnote's element id, apart from the app's own. */
const footnoteId = (identifier: string) => `user-content-fn-${identifier}`

function list(
  tree: TreeNode,
  part: Extract<Part, { type: "list" }>,
  key: number,
  walk: Walk,
): ReactNode {
  const items = tree.children ?? []
  // Loose, as mdast-util-to-hast reads it: its items' paragraphs keep their <p>.
  const loose =
    part.spread === true ||
    items.some((item) => {
      const itemPart = read(item)
      return itemPart.type === "listItem" && itemPart.spread === true
    })
  const rendered = items.map((item, index) => {
    const itemPart = read(item)
    return itemPart.type === "listItem"
      ? listItem(item, itemPart, index, loose, walk)
      : render(item, index, walk)
  })
  return part.ordered === true ? (
    <ol key={key} start={part.start ?? undefined}>
      {rendered}
    </ol>
  ) : (
    <ul key={key}>{rendered}</ul>
  )
}

/**
 * A list item. A task item's checkbox leads its first paragraph; ticking it
 * is kept only while the page is shown. A tight list's paragraphs are
 * their text.
 */
function listItem(
  tree: TreeNode,
  part: Extract<Part, { type: "listItem" }>,
  key: number,
  loose: boolean,
  walk: Walk,
): ReactNode {
  const box =
    typeof part.checked === "boolean" ? (
      <input key="task" type="checkbox" defaultChecked={part.checked} />
    ) : null
  const items = tree.children ?? []
  const leadsWithParagraph = items[0] !== undefined && read(items[0]).type === "paragraph"
  const rendered = items.map((child, index) => {
    if (read(child).type !== "paragraph") return render(child, index, walk)
    const inner = [...(index === 0 && box !== null ? [box] : []), ...children(child, walk)]
    return loose ? <p key={index}>{inner}</p> : <Fragment key={index}>{inner}</Fragment>
  })
  return (
    <li key={key} className={box === null ? undefined : "task"}>
      {leadsWithParagraph ? null : box}
      {rendered}
    </li>
  )
}

function table(
  tree: TreeNode,
  part: Extract<Part, { type: "table" }>,
  key: number,
  walk: Walk,
): ReactNode {
  const [head, ...body] = tree.children ?? []
  const align = part.align ?? []
  const row = (rowNode: TreeNode, rowKey: number, cell: "th" | "td") => (
    <tr key={rowKey}>
      {(rowNode.children ?? []).map((cellNode, column) => {
        const side = align[column]
        return createElement(
          cell,
          { key: column, style: side ? { textAlign: side } : undefined },
          children(cellNode, walk),
        )
      })}
    </tr>
  )
  return (
    <table key={key}>
      {head === undefined ? null : <thead>{row(head, 0, "th")}</thead>}
      {body.length === 0 ? null : (
        <tbody>{body.map((rowNode, index) => row(rowNode, index, "td"))}</tbody>
      )}
    </table>
  )
}

/** A link: clickable to a `linkTarget`, else its text and its URL. */
function link(
  url: string,
  title: string | null | undefined,
  content: ReactNode,
  key: number,
): ReactNode {
  const target = linkTarget(url)
  if (target !== undefined)
    return (
      <a key={key} href={target} title={title ?? undefined}>
        {content}
      </a>
    )
  return (
    <span key={key} className="unlinked">
      {content}
      {url === "" ? null : <span className="unlinked-url"> ({url})</span>}
    </span>
  )
}

/** A file the runbook shows, as its kind, alt text and URL. It loads nothing. */
function media(kind: string, alt: string | null | undefined, url: string, key: number): ReactNode {
  return (
    <span key={key} className="media" data-media={kind.toLowerCase()}>
      {kind}
      {alt ? `: ${alt}` : ""}
      {url === "" ? "" : ` (${url})`}
    </span>
  )
}

/** An image the markdown names: created from its asset URL, or else its alt text and URL. */
function image(alt: string | null | undefined, url: string, key: number, walk: Walk): ReactNode {
  const src = assetUrl(url, walk.session)
  if (src === undefined) return media("Image", alt, url, key)
  return <img key={key} src={src} alt={alt ?? undefined} />
}

/** Whether `tree` is a `<source>` whose `src` names an asset. */
function isAssetSource(tree: TreeNode, walk: Walk): boolean {
  const part = read(tree)
  if (part.type !== "mdxJsxFlowElement" && part.type !== "mdxJsxTextElement") return false
  const src = part.name === "source" ? stringProp(part.props, "src") : undefined
  return src !== undefined && assetUrl(src, walk.session) !== undefined
}

/**
 * An `<img>`, `<video>`, `<audio>` or `<source>` the author wrote. It is
 * created when its `src` names an asset, or for a video or audio with no
 * `src` that holds a `<source>` that does, with only the props
 * `MEDIA_PROPS` names; else it is its kind, alt text and URL, then its
 * children.
 */
function mediaElement(
  tree: TreeNode,
  name: string,
  kind: string,
  props: Readonly<Record<string, unknown>>,
  key: number,
  walk: Walk,
): ReactNode {
  const written = stringProp(props, "src")
  const src = written === undefined ? undefined : assetUrl(written, walk.session)
  const fromSources =
    written === undefined &&
    (name === "video" || name === "audio") &&
    (tree.children ?? []).some((child) => isAssetSource(child, walk))
  if (src === undefined && !fromSources)
    return (
      <Fragment key={key}>
        {media(kind, stringProp(props, "alt") ?? stringProp(props, "title"), written ?? "", 0)}
        {children(tree, walk)}
      </Fragment>
    )
  const kept: Record<string, unknown> = { src }
  const allowed = MEDIA_PROPS.get(name)
  for (const [writtenName, value] of Object.entries(props)) {
    const lower = writtenName.toLowerCase()
    if (name === "video" && lower === "poster") {
      const poster = typeof value === "string" ? assetUrl(value, walk.session) : undefined
      if (poster !== undefined) kept["poster"] = poster
      continue
    }
    const prop = allowed?.get(lower)
    if (prop === undefined) continue
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      kept[prop] = value
  }
  if (name === "video" || name === "audio")
    return createElement(name, { key, ...kept }, children(tree, walk))
  // An <img> or <source> takes no children: any the author wrote follow it.
  return (
    <Fragment key={key}>
      {createElement(name, kept)}
      {children(tree, walk)}
    </Fragment>
  )
}

/** The string value of `name` in `props`, matched without case, as the DOM matches attributes. */
function stringProp(props: Readonly<Record<string, unknown>>, name: string): string | undefined {
  for (const [written, value] of Object.entries(props))
    if (written.toLowerCase() === name && typeof value === "string") return value
  return undefined
}

/** An HTML element the author wrote, with the props `PROPS` allows. */
function element(
  tree: TreeNode,
  name: string,
  props: Readonly<Record<string, unknown>>,
  key: number,
  walk: Walk,
): ReactNode {
  if (name === "a")
    return link(
      stringProp(props, "href") ?? "",
      stringProp(props, "title"),
      children(tree, walk),
      key,
    )
  const kind = MEDIA.get(name)
  if (kind !== undefined) return mediaElement(tree, name, kind, props, key, walk)
  const kept: Record<string, unknown> = { key }
  const own = ELEMENT_PROPS.get(name)
  for (const [written, value] of Object.entries(props)) {
    const lower = written.toLowerCase()
    const prop = PROPS.get(lower) ?? own?.get(lower)
    if (prop === undefined) continue
    if (prop === "style") {
      const style = decodeStyle(value)
      if (Option.isSome(style)) kept[prop] = style.value
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      kept[prop] = value
  }
  return createElement(name, kept, VOID.has(name) ? undefined : children(tree, walk))
}
