/**
 * The reference graph: each reference a block makes, checked against the
 * block it names, as edges between block indices. A reference is a
 * configuration error when it names no block, names a block without the
 * capability its prop needs, reads an output key the block does not
 * declare, or closes a cycle.
 */
import type { BlockId, Capability } from "@runbooks/blocks-core/contract"
import { type AnyBlock, type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import type { BlockErrorCode, Span } from "./configError.ts"
import type { BlockNode, Edge, EdgeSource } from "./document.ts"
import { nearest } from "./nearest.ts"

/** One reference as the author wrote it, before the block it names is looked up. */
export interface WrittenReference {
  /** The index of the block that reads. */
  readonly from: number
  /** The prop the reference is written in. */
  readonly prop: string
  readonly target: BlockId
  /** The target's id as written, for messages. */
  readonly targetAsWritten: string
  readonly source: EdgeSource
  readonly span: Span
}

/** Reports one configuration error at a reference, in the block at `index`, the reading block. */
export type Report = (
  code: BlockErrorCode,
  message: string,
  span: Span,
  more: {
    readonly block: { readonly tag: string; readonly id?: string }
    readonly prop: string
    readonly suggestion?: string
    readonly index: number
  },
) => void

/** What a block with the capability does, as it reads after "which doesn't". */
const DOES: Record<Capability, string> = {
  values: "give values",
  run: "run",
  env: "give environment variables",
  "git-credential": "give a git credential",
  repository: "give a repository",
}

/**
 * The edges `references` make between `blocks`, each reference that fails
 * reported and left out. Two references with the same source between the
 * same blocks make one edge, at the first.
 */
export function referenceGraph(
  blocks: ReadonlyArray<BlockNode>,
  references: ReadonlyArray<WrittenReference>,
  registry: Registry,
  file: string,
  report: Report,
): Edge[] {
  const byId = new Map<BlockId, BlockNode>()
  for (const node of blocks) {
    if (node.id !== undefined && !byId.has(node.id)) byId.set(node.id, node)
  }
  const ids = blocks.flatMap((node) => (node.idAsWritten === undefined ? [] : [node.idAsWritten]))

  const edges: Edge[] = []
  /** The reference each edge came from, by the edge's position. */
  const madeBy: WrittenReference[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    const from = blocks[reference.from]
    if (from === undefined) continue
    const target = byId.get(reference.target)
    if (target === undefined) {
      const suggestion = nearest(reference.targetAsWritten, ids)
      const missing =
        reference.source._tag === "Prop"
          ? "no block has that id"
          : `no block has the id "${reference.targetAsWritten}"`
      report("missingReference", `${what(reference, from)}, and ${missing}.`, reference.span, {
        ...at(reference, from),
        ...(suggestion !== undefined ? { suggestion } : {}),
      })
      continue
    }
    const block = resolveTag(registry, target.tag)?.block
    if (block !== undefined && !fits(reference, from, target, block, registry, report)) continue
    const key = `${reference.from} ${target.index} ${JSON.stringify(reference.source)}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      from: reference.from,
      to: target.index,
      source: reference.source,
      file,
      span: reference.span,
    })
    madeBy.push(reference)
  }
  reportCycles(blocks, edges, madeBy, report)
  return edges
}

/** "`dependsOn` on <Command id="deploy"> names "setup"", or the template it reads. */
function what(reference: WrittenReference, from: BlockNode): string {
  const { source, prop, targetAsWritten } = reference
  const where = `\`${prop}\` on ${named(from)}`
  return source._tag === "Prop"
    ? `${where} names "${targetAsWritten}"`
    : `${where} reads {{ .outputs.${targetAsWritten}.${source.key} }}`
}

function named(node: BlockNode): string {
  return node.idAsWritten === undefined ? `<${node.tag}>` : `<${node.tag} id="${node.idAsWritten}">`
}

function at(reference: WrittenReference, from: BlockNode) {
  return {
    block: { tag: from.tag, ...(from.idAsWritten !== undefined ? { id: from.idAsWritten } : {}) },
    prop: reference.prop,
    index: from.index,
  }
}

/** Whether `target` gives what `reference` needs: its capability, or the output key it reads. */
function fits(
  reference: WrittenReference,
  from: BlockNode,
  target: BlockNode,
  block: AnyBlock,
  registry: Registry,
  report: Report,
): boolean {
  const { source } = reference
  if (source._tag === "Prop") {
    const { capability } = source
    if (provides(block, capability)) return true
    const providers = Object.keys(registry)
      .filter((tag) => {
        const entry = resolveTag(registry, tag)
        return entry !== undefined && provides(entry.block, capability)
      })
      .sort()
      .map((tag) => `<${tag}>`)
    report(
      "missingCapability",
      `\`${reference.prop}\` on ${named(from)} names ${named(target)}, which doesn't ${DOES[capability]}. ${
        providers.length > 0 ? `Blocks that do: ${providers.join(", ")}.` : "No block does."
      }`,
      reference.span,
      at(reference, from),
    )
    return false
  }
  // Its props did not decode, which is reported; there is nothing to check against.
  if (target.props === undefined) return true
  const declared = block.class === "display" ? [] : Object.keys(block.outputs(target.props))
  if (declared.includes(source.key)) return true
  const suggestion = nearest(source.key, declared)
  report(
    "undeclaredOutput",
    `${what(reference, from)}, and ${named(target)} doesn't declare \`${source.key}\`. ${
      declared.length > 0 ? `It declares: ${declared.join(", ")}.` : "It declares no outputs."
    }`,
    reference.span,
    { ...at(reference, from), ...(suggestion !== undefined ? { suggestion } : {}) },
  )
  return false
}

function provides(block: AnyBlock, capability: Capability): boolean {
  return block.provides.some((provided: Capability) => provided === capability)
}

/**
 * One error for each cycle: each set of blocks that wait for each other,
 * at the first of them in the file, naming the shortest loop through it.
 */
function reportCycles(
  blocks: ReadonlyArray<BlockNode>,
  edges: ReadonlyArray<Edge>,
  madeBy: ReadonlyArray<WrittenReference>,
  report: Report,
): void {
  const out = new Map<number, number[]>()
  for (const [position, edge] of edges.entries()) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), position])
  }
  for (const component of stronglyConnected(blocks.length, edges, out)) {
    const start = Math.min(...component)
    const loop = shortestLoop(start, new Set(component), edges, out)
    const [first] = loop
    if (first === undefined) continue
    const reference = madeBy[first]
    const from = blocks[start]
    if (reference === undefined || from === undefined) continue
    const chain = [...loop.map((position) => edges[position]?.from), start]
      .map((index) => (index === undefined ? "" : blocks[index]?.idAsWritten))
      .join(" → ")
    const message =
      loop.length === 1
        ? `${what(reference, from)}: that is this block. A block can't wait for itself.`
        : `These blocks wait for each other, so none of them can go first: ${chain}.`
    report("cycle", message, reference.span, at(reference, from))
  }
}

/** Tarjan's algorithm: the sets of nodes that can each reach every other one in the set. */
function stronglyConnected(
  size: number,
  edges: ReadonlyArray<Edge>,
  out: ReadonlyMap<number, ReadonlyArray<number>>,
): number[][] {
  const order = new Map<number, number>()
  const low = new Map<number, number>()
  const stack: number[] = []
  const onStack = new Set<number>()
  const components: number[][] = []
  const visit = (node: number): void => {
    order.set(node, order.size)
    low.set(node, order.get(node) ?? 0)
    stack.push(node)
    onStack.add(node)
    for (const position of out.get(node) ?? []) {
      const next = edges[position]?.to
      if (next === undefined) continue
      if (!order.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, order.get(next) ?? 0))
      }
    }
    if (low.get(node) !== order.get(node)) return
    const component: number[] = []
    let member: number | undefined
    do {
      member = stack.pop()
      if (member === undefined) break
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    components.push(component)
  }
  for (let node = 0; node < size; node++) {
    if (!order.has(node)) visit(node)
  }
  return components
}

/** The edges of the shortest path from `start` back to itself inside `members`, or none. */
function shortestLoop(
  start: number,
  members: ReadonlySet<number>,
  edges: ReadonlyArray<Edge>,
  out: ReadonlyMap<number, ReadonlyArray<number>>,
): number[] {
  const reachedBy = new Map<number, number>()
  const queue = [start]
  for (const node of queue) {
    for (const position of out.get(node) ?? []) {
      const next = edges[position]?.to
      if (next === start) {
        const path = [position]
        let back = node
        while (back !== start) {
          const via = reachedBy.get(back)
          if (via === undefined) break
          path.unshift(via)
          back = edges[via]?.from ?? start
        }
        return path
      }
      if (next !== undefined && members.has(next) && !reachedBy.has(next)) {
        reachedBy.set(next, position)
        queue.push(next)
      }
    }
  }
  return []
}
