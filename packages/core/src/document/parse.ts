/**
 * `parseRunbook`: a runbook's source to a typed document, or every
 * configuration error in it, each with its file, line and block. Nothing in
 * the runbook is evaluated. Every client calls it, so every client refuses the
 * same runbooks with the same messages.
 */
import { createHash } from "node:crypto"
import { posix } from "node:path"
import { Result, Schema, SchemaAST, SchemaIssue } from "effect"
import YAML from "yaml"
import {
  BlockId,
  type Capability,
  type ReferenceValue,
  type RunbookPath,
} from "@runbooks/blocks-core/contract"
import { type AnyBlock, type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import {
  type BlockErrorCode,
  byPlace,
  ConfigError,
  ConfigWarning,
  refusesRunbook,
  type RunbookErrorCode,
  type Span,
} from "./configError.ts"
import {
  type BlockNode,
  ContentHash,
  type DocumentHash,
  type FrontMatter,
  type ParseResult,
  SharedProps,
  type TreeNode,
} from "./document.ts"
import type { FileFact, FileText } from "./files.ts"
import { referenceGraph, type WrittenReference } from "./graph.ts"
import { refusals } from "./literalOnly.ts"
import {
  attributeValue,
  expressionValue,
  type MdxNode,
  parseMdx,
  type PropValue,
  splitFrontMatter,
} from "./mdx.ts"
import { nearest } from "./nearest.ts"
import { REQUIREMENT_KEY, versionProblem } from "./runbooksVersion.ts"
import { templateReferences } from "./templateReferences.ts"

export interface ParseOptions {
  /** The runbook file, as every location names it. */
  readonly file: string
  /** This app's version, checked against the front matter's `runbooks:`. */
  readonly appVersion: string
}

/**
 * The document `source` parses to with `registry`'s blocks, or every
 * configuration error in it. `files` holds what is at each path a block
 * names, as `loadRunbook` reads it. A path missing from it is a `badFile`
 * error, so a document's hash never leaves out a file a block uses.
 *
 * A runbook whose front matter needs another version of Runbooks gets only
 * that error: its other problems are likely the blocks a later version added.
 */
export function parseRunbook(
  source: string,
  registry: Registry,
  options: ParseOptions,
  files: ReadonlyMap<RunbookPath, FileFact> = new Map(),
): ParseResult {
  return startParse(source, registry, options).finish(files)
}

/** A parse in two steps, for a caller that reads the files the blocks name in between. */
export interface StartedParse {
  /** Each path a block names, once, relative to the runbook's folder. */
  readonly files: ReadonlyArray<RunbookPath>
  readonly finish: (files: ReadonlyMap<RunbookPath, FileFact>) => ParseResult
}

export function startParse(
  source: string,
  registry: Registry,
  options: ParseOptions,
): StartedParse {
  const parse = new Parse(source, registry, options)
  const files = parse.start()
  return { files, finish: (facts) => parse.finish(facts) }
}

/**
 * The props named `<cloud>AuthId` that `envFrom` replaces (open decision 5).
 * On a block that takes `envFrom` and has no prop of that name, each is read
 * as one more `envFrom` source, after `envFrom`'s own, with a warning.
 */
const ENV_FROM_ALIASES: ReadonlySet<string> = new Set([
  "awsAuthId",
  "googleAuthId",
  "azureAuthId",
  "githubAuthId",
  "gitAuthId",
])

/**
 * The name `gitAuthId` replaced (open decision 5). On a block whose own
 * reference prop needs `git-credential`, it is read as that prop, with a
 * warning; when both are written, the block's own prop wins.
 */
const GIT_CREDENTIAL_ALIAS = "githubAuthId"

type SharedKey = keyof typeof SharedProps.fields
const SHARED_KEYS: ReadonlySet<string> = new Set(Object.keys(SharedProps.fields))
const isShared = (key: string): key is SharedKey => SHARED_KEYS.has(key)

/** The shared props that name other blocks, each with the capability its targets must provide. */
const SHARED_REFERENCES = [
  ["inputsId", "values"],
  ["dependsOn", "run"],
  ["envFrom", "env"],
] as const satisfies ReadonlyArray<readonly [SharedKey, Capability]>

/** Whether `block` takes the shared prop `key`: it depends on its class and its effects. */
function takes(block: AnyBlock, key: SharedKey): boolean {
  switch (key) {
    case "title":
    case "description":
    case "inputsId":
      return true
    case "autoCollapse":
      return block.class !== "display"
    case "dependsOn":
      return block.class === "task"
    case "envFrom":
    case "env":
      return block.class === "task" && block.effects.some((effect) => effect === "process")
  }
}

const toBlockId = Schema.decodeSync(BlockId)
const toHash = Schema.decodeSync(ContentHash)
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** One prop as written: its value, where it is, and its attribute node. */
interface Written {
  readonly value: PropValue
  readonly span: Span
}

type Where = { readonly tag: string; readonly id?: string }

/** The rest of an error: its details, and the block, prop and file it is in. */
type ErrorDetail = Partial<Pick<ConfigError, "expected" | "received" | "suggestion">> & {
  readonly block?: Where
  readonly prop?: string
  /** A file the runbook's blocks name, when the error is in it. */
  readonly file?: string
}

/** A path a block names, with the prop that names it when one holds it as written. */
interface NamedFile {
  readonly index: number
  readonly path: RunbookPath
  readonly where: Where
  readonly prop?: string
  readonly span: Span
}

class Parse {
  /** Every error, the runbook's and the blocks'. */
  private readonly errors: ConfigError[] = []
  /** Each block's errors, by its index. */
  private readonly blockErrors = new Map<number, ConfigError[]>()
  private readonly warnings: ConfigWarning[] = []
  private readonly blocks: Array<BlockNode | undefined> = []
  /** Every reference a block makes, in file order, checked once every block is known. */
  private readonly references: WrittenReference[] = []
  /** Attribute and expression nodes the literal check refused, which have no value to read. */
  private readonly refused = new Set<MdxNode>()
  /** Every path a block names, in file order. */
  private readonly named: NamedFile[] = []
  private frontMatterRead: FrontMatter = {}
  private tree: TreeNode = { type: "root", children: [] }
  /** The result when the parse stopped early, at the front matter's version or a syntax error. */
  private stopped: ParseResult | undefined

  private readonly source: string
  private readonly registry: Registry
  private readonly options: ParseOptions

  constructor(source: string, registry: Registry, options: ParseOptions) {
    this.source = source
    this.registry = registry
    this.options = options
  }

  /** Reads the runbook. Returns each path its blocks name, once, for `finish`. */
  start(): ReadonlyArray<RunbookPath> {
    const { yaml, body } = splitFrontMatter(this.source)
    if (yaml !== undefined) this.frontMatterRead = this.frontMatter(yaml)
    const version = this.errors.find((error) => error.code === "versionRequired")
    if (version !== undefined) {
      this.stopped = this.invalid(version)
      return []
    }

    const parsed = parseMdx(body)
    if ("problem" in parsed) {
      const { reason, at } = parsed.problem
      this.stopped = this.invalid(this.error("syntax", reason, { start: at, end: at }))
      return []
    }

    for (const refusal of refusals(parsed.tree)) {
      this.refused.add(refusal.node)
      const { element } = refusal
      const tag = element !== undefined && /^[A-Z]/.test(element) ? element : undefined
      this.error("notAllowed", refusal.message, spanOf(refusal.node), {
        ...(tag !== undefined ? { block: { tag } } : {}),
        ...(refusal.prop !== undefined ? { prop: refusal.prop } : {}),
      })
    }

    const [tree] = this.node(parsed.tree)
    if (tree !== undefined) this.tree = tree
    this.duplicateIds()
    return [...new Set(this.named.map((named) => named.path))]
  }

  /** The result, given what is at each path `start` returned. */
  finish(files: ReadonlyMap<RunbookPath, FileFact>): ParseResult {
    if (this.stopped !== undefined) return this.stopped
    const hashes = new Map<RunbookPath, ContentHash>()
    for (const named of this.named) {
      const fact = files.get(named.path)
      if (fact?._tag === "Found") {
        hashes.set(named.path, fact.hash)
        this.fileReads(named, fact.texts)
      } else {
        this.badFile(named, fact)
      }
    }
    const blocks = this.blocks.filter((block) => block !== undefined)
    const edges = referenceGraph(
      blocks,
      this.references,
      this.registry,
      this.options.file,
      (code, message, span, more) => {
        this.error(code, message, span, more)
      },
    )
    const refusing = this.errors.find((error) => refusesRunbook(error.code))
    if (refusing !== undefined) return this.invalid(refusing)
    const order = byPlace(this.options.file)
    return {
      _tag: "Parsed",
      document: {
        file: this.options.file,
        frontMatter: this.frontMatterRead,
        tree: this.tree,
        blocks: blocks.map((node) => ({
          ...node,
          errors: [...(this.blockErrors.get(node.index) ?? [])].sort(order),
        })),
        edges,
        hash: documentHash(this.source, hashes),
        warnings: [...this.warnings].sort(order),
      },
    }
  }

  /** A file the loader did not find inside the runbook's folder, or did not read. */
  private badFile(named: NamedFile, fact: FileFact | undefined): void {
    const { where, prop } = named
    const block = where.id === undefined ? `<${where.tag}>` : `<${where.tag} id="${where.id}">`
    const subject = `${prop === undefined ? block : `\`${prop}\` on ${block}`} names ${named.path}`
    const message =
      fact === undefined
        ? `${subject}, which was not read. Load the runbook with loadRunbook, which reads the files its blocks name.`
        : fact._tag === "Outside"
          ? `${subject}, which is outside the runbook's folder. A block can only name files in its runbook's folder.`
          : `${subject}, which doesn't exist. The path is relative to the runbook's folder.`
    this.error("badFile", message, named.span, {
      index: named.index,
      block: where,
      ...(prop !== undefined ? { prop } : {}),
    })
  }

  /** Each `{{ .outputs.<id>.<key> }}` in the files a block names, at its line in the file. */
  private fileReads(named: NamedFile, texts: ReadonlyArray<FileText>): void {
    for (const { path: relative, text } of texts) {
      const inFile = {
        path: relative,
        location: posix.join(posix.dirname(this.options.file), relative),
      }
      for (const reference of templateReferences(text)) {
        if (reference._tag !== "Output") continue
        this.references.push({
          from: named.index,
          ...(named.prop !== undefined ? { prop: named.prop } : {}),
          target: reference.block,
          targetAsWritten: reference.blockAsWritten,
          source: { _tag: "Output", key: reference.key, guarded: reference.guarded },
          span: reference.span,
          inFile,
        })
      }
    }
  }

  /** Every error so far, in file order. `first` is one of them, so there is at least one. */
  private invalid(first: ConfigError): ParseResult {
    const errors: [ConfigError, ...ConfigError[]] = [
      first,
      ...this.errors.filter((error) => error !== first),
    ]
    return {
      _tag: "Invalid",
      errors: errors.sort(byPlace(this.options.file)),
      warnings: [...this.warnings].sort(byPlace(this.options.file)),
    }
  }

  /** An error that refuses the runbook, or one in the block at `index`, which stops only it. */
  private error(
    code: RunbookErrorCode,
    message: string,
    span: Span,
    more?: ErrorDetail,
  ): ConfigError
  private error(
    code: BlockErrorCode,
    message: string,
    span: Span,
    more: ErrorDetail & { readonly index: number },
  ): ConfigError
  private error(
    code: RunbookErrorCode | BlockErrorCode,
    message: string,
    span: Span,
    more: ErrorDetail & { readonly index?: number } = {},
  ): ConfigError {
    const { block, prop, index, file, ...detail } = more
    const error = new ConfigError({
      code,
      message,
      location: {
        file: file ?? this.options.file,
        span,
        ...(block ? { block } : {}),
        ...(prop !== undefined ? { prop } : {}),
      },
      ...detail,
    })
    this.errors.push(error)
    if (index !== undefined)
      this.blockErrors.set(index, [...(this.blockErrors.get(index) ?? []), error])
    return error
  }

  private warn(
    code: ConfigWarning["code"],
    message: string,
    span: Span,
    block: { readonly tag: string; readonly id?: string },
    prop: string,
    suggestion?: string,
  ): void {
    this.warnings.push(
      new ConfigWarning({
        code,
        message,
        location: { file: this.options.file, span, block, prop },
        ...(suggestion !== undefined ? { suggestion } : {}),
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Front matter
  // -------------------------------------------------------------------------

  private frontMatter(yaml: string): FrontMatter {
    const doc = YAML.parseDocument(yaml)
    const [problem] = doc.errors
    if (problem) {
      // The YAML starts on the file's second line, after `---`.
      const line = 1 + (problem.linePos?.[0].line ?? 1)
      this.error("syntax", `The front matter isn't valid YAML: ${problem.message}`, lineSpan(line))
      return {}
    }
    const fields: unknown = doc.toJS()
    if (typeof fields !== "object" || fields === null) return {}
    const record = fields as Record<string, unknown>

    const frontMatter: { runbooks?: string; title?: string } = {}
    if (typeof record.title === "string") frontMatter.title = record.title
    if (REQUIREMENT_KEY in record) {
      const requirement = record[REQUIREMENT_KEY]
      const unmet = versionProblem(requirement, this.options.appVersion)
      if (unmet !== undefined) {
        const index = yaml.split("\n").findIndex((l) => l.startsWith(`${REQUIREMENT_KEY}:`))
        this.error("versionRequired", unmet, lineSpan(index + 2), {
          expected: `a version range such as ${REQUIREMENT_KEY}: ">= 0.28"`,
        })
      } else if (typeof requirement === "string") {
        frontMatter.runbooks = requirement
      }
    }
    return frontMatter
  }

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------

  /** `node` as the document's tree holds it: none, one, or a fragment's children. */
  private node(node: MdxNode): TreeNode[] {
    switch (node.type) {
      case "mdxjsEsm":
        return []
      case "mdxFlowExpression":
      case "mdxTextExpression": {
        const value = expressionValue(node)
        return typeof value === "string" || typeof value === "number"
          ? [{ type: "text", value: String(value) }]
          : []
      }
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        const name = node.name
        if (!name) return this.children(node)
        if (/^[a-z]/.test(name) && !/[.:-]/.test(name)) return [this.element(node, name)]
        if (/^[A-Z]/.test(name) && !/[.:-]/.test(name)) return this.block(node, name)
        return []
      }
      default: {
        const { position: _position, data: _data, children, ...fields } = node
        return [{ ...fields, ...(children ? { children: this.children(node) } : {}) }]
      }
    }
  }

  private children(node: MdxNode): TreeNode[] {
    return (node.children ?? []).flatMap((child) => this.node(child))
  }

  /** An HTML element: its literal props and its children. */
  private element(node: MdxNode, name: string): TreeNode {
    const props: Record<string, PropValue> = {}
    for (const attribute of node.attributes ?? []) {
      if (attribute.type !== "mdxJsxAttribute" || !attribute.name) continue
      const value = attributeValue(attribute.value)
      if (value !== undefined) props[attribute.name] = value
    }
    return { type: node.type, name, props, children: this.children(node) }
  }

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  private block(node: MdxNode, tag: string): TreeNode[] {
    const span = spanOf(node)
    const resolved = resolveTag(this.registry, tag)
    if (resolved === undefined) {
      const suggestion = nearest(tag, Object.keys(this.registry))
      this.error(
        "unknownBlock",
        `This runbook uses <${tag}>, a block that Runbooks ${this.options.appVersion} doesn't have. If a later version of Runbooks added it, update Runbooks to use this runbook. Otherwise, check its name.`,
        span,
        { block: { tag }, ...(suggestion ? { suggestion: `<${suggestion}>` } : {}) },
      )
      return []
    }
    const { block, locked } = resolved
    const index = this.blocks.push(undefined) - 1

    const written = this.written(node, tag, index)
    const id = this.id(written, tag, block, span, index)
    const where = { tag, ...(id ? { id: id.asWritten } : {}) }
    const own = propKeys(block.props)
    const childrenProp = block.children.kind === "yaml" ? block.children.prop : undefined
    const credentialProp = Object.entries(block.references).find(
      ([, capability]) => capability === "git-credential",
    )?.[0]

    const shared: Record<string, PropValue> = {}
    const aliases: Array<[string, Written]> = []
    const input: Record<string, unknown> = {}
    let credentialAlias: Written | undefined
    for (const [key, prop] of written) {
      if (key === "id") continue
      const ownsKey = own === undefined ? !isShared(key) : own.has(key)
      if (isShared(key) && takes(block, key)) shared[key] = prop.value
      else if (key === GIT_CREDENTIAL_ALIAS && !ownsKey && credentialProp !== undefined) {
        credentialAlias = prop
      } else if (ENV_FROM_ALIASES.has(key) && !ownsKey && takes(block, "envFrom")) {
        aliases.push([key, prop])
      } else if (!ownsKey && key !== childrenProp) {
        const known = [
          ...(own ?? []),
          ...[...SHARED_KEYS].filter(isShared).filter((k) => takes(block, k)),
        ]
        const suggestion = nearest(key, known)
        this.warn(
          "unknownProp",
          `<${tag}> has no \`${key}\` prop, so it is ignored.`,
          prop.span,
          where,
          key,
          suggestion,
        )
      }
      if (ownsKey) input[key] = prop.value
    }
    if (credentialAlias !== undefined && credentialProp !== undefined) {
      this.credentialAlias(credentialAlias, credentialProp, input, where, index)
    }

    for (const key of Object.keys(locked)) {
      const prop = written.get(key)
      if (prop) {
        this.error(
          "lockedProp",
          `<${tag}> sets \`${key}\` itself. Remove the prop, or use <${block.name}>.`,
          prop.span,
          { block: where, prop: key, index },
        )
      }
    }
    Object.assign(input, locked)

    let children: TreeNode[] = []
    if (block.children.kind === "markdown") children = this.children(node)
    const yamlRead =
      childrenProp === undefined || this.yamlChildren(node, childrenProp, input, where, index)

    const decodedShared = this.decodeShared(index, shared, aliases, written, span, where)
    const props = Schema.decodeUnknownResult(block.props)(input)
    if (Result.isFailure(props)) {
      // YAML that did not parse is already reported; its prop's absence is not news.
      const skip = yamlRead ? undefined : childrenProp
      this.badProps(index, props.failure.issue, written, span, where, childrenProp, skip)
    } else {
      for (const file of block.runbookFiles(props.success)) {
        const prop = [...written].find(([, value]) => value.value === file)?.[0]
        const at = prop === undefined ? undefined : written.get(prop)
        this.named.push({
          index,
          path: file,
          where,
          span: at?.span ?? span,
          ...(prop ? { prop } : {}),
        })
      }
      for (const [prop, capability] of Object.entries(block.references)) {
        const value: unknown = props.success[prop]
        if (capability === undefined || !isReferenceValue(value)) continue
        // Read from `githubAuthId`: the edge names the prop the author wrote.
        const alias = prop === credentialProp && !written.has(prop) ? credentialAlias : undefined
        const as = alias === undefined ? prop : GIT_CREDENTIAL_ALIAS
        this.refer(index, as, capability, alias ?? written.get(prop), value, span)
      }
    }
    for (const [prop, value] of [...Object.entries(input), ...Object.entries(shared)]) {
      this.templateReads(index, prop, value, written.get(prop)?.span ?? span)
    }

    this.blocks[index] = {
      index,
      tag,
      block: block.name,
      class: block.class,
      ...(id ? { id: id.id, idAsWritten: id.asWritten } : {}),
      props: Result.isSuccess(props) ? props.success : undefined,
      shared: decodedShared,
      span,
      errors: [],
    }
    return [{ type: "block", index, children }]
  }

  /** The props as written, in order. A later duplicate wins, as in JSX. */
  private written(node: MdxNode, tag: string, index: number): Map<string, Written> {
    const written = new Map<string, Written>()
    for (const attribute of node.attributes ?? []) {
      if (attribute.type !== "mdxJsxAttribute" || !attribute.name) continue
      if (this.refused.has(attribute)) continue
      const value = attributeValue(attribute.value)
      const span = spanOf(attribute)
      if (value === undefined) {
        this.error(
          "badProp",
          `the \`${attribute.name}\` prop of <${tag}> holds a regular expression or a bigint, which no block takes.`,
          span,
          { block: { tag }, prop: attribute.name, index },
        )
        continue
      }
      written.delete(attribute.name)
      written.set(attribute.name, { value, span })
    }
    return written
  }

  private id(
    written: ReadonlyMap<string, Written>,
    tag: string,
    block: AnyBlock,
    span: Span,
    index: number,
  ): { readonly id: BlockId; readonly asWritten: string } | undefined {
    const prop = written.get("id")
    if (prop !== undefined) {
      if (typeof prop.value === "string" && prop.value !== "") {
        return { id: toBlockId(prop.value), asWritten: prop.value }
      }
      this.error(
        "badProp",
        `the \`id\` of <${tag}> must be text, such as id="deploy".`,
        prop.span,
        {
          block: { tag },
          prop: "id",
          index,
          expected: "a block id",
          received: excerpt(prop.value),
        },
      )
      return undefined
    }
    if (block.class !== "display") {
      this.error(
        "missingId",
        `<${tag}> needs an id, such as id="deploy", so other blocks and the runbook's tests can name it.`,
        span,
        { block: { tag }, prop: "id", index, expected: "a block id" },
      )
    }
    return undefined
  }

  /**
   * The fenced YAML among a block's children, parsed into the prop that takes
   * it. False when the YAML does not parse, which it reports.
   */
  private yamlChildren(
    node: MdxNode,
    prop: string,
    input: Record<string, unknown>,
    where: Where,
    index: number,
  ): boolean {
    const fence = (node.children ?? []).find(
      (child) => child.type === "code" && (child.lang === "yaml" || child.lang === "yml"),
    )
    if (fence === undefined || typeof fence.value !== "string") return true
    const doc = YAML.parseDocument(fence.value)
    const [problem] = doc.errors
    if (problem) {
      // The YAML starts on the line after the fence's opening line.
      const line = spanOf(fence).start.line + (problem.linePos?.[0].line ?? 1)
      this.error(
        "badChildren",
        `The YAML in <${where.tag}> isn't valid: ${problem.message}`,
        lineSpan(line),
        {
          block: where,
          prop,
          index,
        },
      )
      return false
    }
    input[prop] = doc.toJS()
    return true
  }

  /** `githubAuthId` read as the block's `git-credential` prop, unless that prop is written too. */
  private credentialAlias(
    alias: Written,
    prop: string,
    input: Record<string, unknown>,
    where: Where,
    index: number,
  ): void {
    if (typeof alias.value !== "string" || alias.value === "") {
      this.error(
        "badProp",
        `\`${GIT_CREDENTIAL_ALIAS}\` must be a block id, such as ${prop}="git-auth".`,
        alias.span,
        {
          block: where,
          prop: GIT_CREDENTIAL_ALIAS,
          index,
          expected: "a block id",
          received: excerpt(alias.value),
        },
      )
      return
    }
    if (input[prop] !== undefined) {
      this.warn(
        "deprecatedProp",
        `\`${GIT_CREDENTIAL_ALIAS}\` is ignored: \`${prop}\` replaces it, and is set.`,
        alias.span,
        where,
        GIT_CREDENTIAL_ALIAS,
      )
      return
    }
    input[prop] = alias.value
    this.warn(
      "deprecatedProp",
      `\`${GIT_CREDENTIAL_ALIAS}\` still works, and \`${prop}\` replaces it: ${prop}="${alias.value}" names the same block.`,
      alias.span,
      where,
      GIT_CREDENTIAL_ALIAS,
      `${prop}="${alias.value}"`,
    )
  }

  /** Each block a reference prop names, in order, with its id as written. */
  private refer(
    from: number,
    prop: string,
    capability: Capability,
    at: Written | undefined,
    value: ReferenceValue,
    fallback: Span,
  ): void {
    const targets = typeof value === "string" ? [value] : value
    const written = at === undefined ? [] : Array.isArray(at.value) ? at.value : [at.value]
    for (const [position, target] of targets.entries()) {
      const asWritten = written[position]
      this.references.push({
        from,
        prop,
        target,
        targetAsWritten: typeof asWritten === "string" ? asWritten : target,
        source: { _tag: "Prop", prop, capability },
        span: at?.span ?? fallback,
      })
    }
  }

  /** Each `{{ .outputs.<id>.<key> }}` in the strings of one prop. */
  private templateReads(from: number, prop: string, value: unknown, span: Span): void {
    for (const text of strings(value)) {
      for (const reference of templateReferences(text)) {
        if (reference._tag !== "Output") continue
        this.references.push({
          from,
          prop,
          target: reference.block,
          targetAsWritten: reference.blockAsWritten,
          source: { _tag: "Output", key: reference.key, guarded: reference.guarded },
          span,
        })
      }
    }
  }

  private decodeShared(
    index: number,
    shared: Record<string, PropValue>,
    aliases: ReadonlyArray<[string, Written]>,
    written: ReadonlyMap<string, Written>,
    span: Span,
    where: { readonly tag: string; readonly id?: string },
  ): SharedProps {
    const decoded = Schema.decodeUnknownResult(SharedProps)(shared)
    if (Result.isFailure(decoded)) {
      this.badProps(index, decoded.failure.issue, written, span, where, undefined)
      return {}
    }
    for (const [key, capability] of SHARED_REFERENCES) {
      const value = decoded.success[key]
      if (value !== undefined) this.refer(index, key, capability, written.get(key), value, span)
    }
    const envFrom = [...(decoded.success.envFrom ?? [])]
    for (const [key, prop] of aliases) {
      if (typeof prop.value !== "string" || prop.value === "") {
        this.error("badProp", `\`${key}\` must be a block id, such as ${key}="aws".`, prop.span, {
          block: where,
          prop: key,
          index,
          expected: "a block id",
          received: excerpt(prop.value),
        })
        continue
      }
      const id = toBlockId(prop.value)
      envFrom.push(id)
      this.refer(index, key, "env", prop, id, span)
      this.warn(
        "deprecatedProp",
        `\`${key}\` still works, and \`envFrom\` replaces it: envFrom={["${prop.value}"]} passes the same variables.`,
        prop.span,
        where,
        key,
        `envFrom={["${prop.value}"]}`,
      )
    }
    return envFrom.length > 0 ? { ...decoded.success, envFrom } : decoded.success
  }

  /** One error per prop the schema refused. */
  private badProps(
    index: number,
    issue: SchemaIssue.Issue,
    written: ReadonlyMap<string, Written>,
    fallback: Span,
    where: { readonly tag: string; readonly id?: string },
    childrenProp: string | undefined,
    skip?: string,
  ): void {
    const byProp = new Map<string, string[]>()
    for (const { message, path = [] } of formatIssue(issue).issues) {
      const [head, ...rest] = path.map((segment) =>
        typeof segment === "object" ? String(segment.key) : String(segment),
      )
      const prop = head ?? ""
      const at = rest.length > 0 ? ` (at ${rest.join(".")})` : ""
      byProp.set(prop, [...(byProp.get(prop) ?? []), `${message}${at}`])
    }
    for (const [prop, messages] of byProp) {
      if (prop === skip) continue
      const value = written.get(prop)
      const missing = value === undefined && messages.every((m) => m === "Missing key")
      const code: BlockErrorCode = prop === childrenProp ? "badChildren" : "badProp"
      const message = missing
        ? `<${where.tag}> needs the \`${prop}\` prop.`
        : `the \`${prop}\` prop of <${where.tag}>: ${messages.join("; ")}`
      this.error(code, message, value?.span ?? fallback, {
        block: where,
        index,
        ...(prop !== "" ? { prop } : {}),
        ...(value !== undefined ? { received: excerpt(value.value) } : {}),
      })
    }
  }

  /** An error for every block whose id another block before it already has. */
  private duplicateIds(): void {
    const first = new Map<BlockId, BlockNode>()
    for (const node of this.blocks) {
      if (node?.id === undefined) continue
      const earlier = first.get(node.id)
      if (earlier === undefined) {
        first.set(node.id, node)
        continue
      }
      const line = earlier.span.start.line
      const same = earlier.idAsWritten === node.idAsWritten
      this.error(
        "duplicateId",
        same
          ? `<${earlier.tag}> on line ${line} already has the id "${node.idAsWritten}". Each block needs its own id.`
          : `"${node.idAsWritten}" is the same id as "${earlier.idAsWritten}" on line ${line}: a hyphen and an underscore are the same in an id. Each block needs its own id.`,
        node.span,
        {
          block: { tag: node.tag, ...(node.idAsWritten ? { id: node.idAsWritten } : {}) },
          prop: "id",
          index: node.index,
        },
      )
    }
  }
}

const isReferenceValue = (value: unknown): value is ReferenceValue =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every((entry) => typeof entry === "string"))

/** Every string in a prop's value, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings)
  return []
}

const LINE_ONE: Span = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }

function lineSpan(line: number): Span {
  return { start: { line, column: 1 }, end: { line: line + 1, column: 1 } }
}

function spanOf(node: MdxNode): Span {
  const { start, end } = node.position ?? { start: LINE_ONE.start, end: LINE_ONE.end }
  return {
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
  }
}

/**
 * The keys a props schema reads, from its encoded side. Undefined when the
 * schema takes any key (a record) or its shape cannot be read, so no prop is
 * reported unknown.
 */
function propKeys(schema: Schema.Top): ReadonlySet<string> | undefined {
  const keys = new Set<string>()
  const collect = (ast: SchemaAST.AST): boolean => {
    if (ast._tag === "Objects") {
      for (const signature of ast.propertySignatures) keys.add(String(signature.name))
      return ast.indexSignatures.length === 0
    }
    if (ast._tag === "Union") return ast.types.every(collect)
    return false
  }
  return collect(SchemaAST.toEncoded(schema.ast)) ? keys : undefined
}

function excerpt(value: PropValue): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

/** The runbook's hash, each file's, and one over both, the files in path order. */
function documentHash(source: string, files: ReadonlyMap<RunbookPath, ContentHash>): DocumentHash {
  const runbook = toHash(sha256(source))
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const record: Record<RunbookPath, ContentHash> = {}
  for (const [file, hash] of entries) record[file] = hash
  return {
    runbook,
    files: record,
    combined: toHash(sha256(JSON.stringify({ runbook, files: entries }))),
  }
}

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
