/**
 * The registry's types and the checks on it. The registry itself is
 * `blocks/index.ts`: one re-export per block or alias, named by its MDX tag,
 *
 *   export { command as Command } from "./command/block.ts"
 *
 * so `import * as registry from "@runbooks/blocks"` is the tag-to-entry map,
 * and its type carries each block's props, class and services.
 */
import type { Schema } from "effect"
import type {
  Alias,
  BlockClass,
  CredentialBlock,
  DisplayBlock,
  FormBlock,
  TaskBlock,
} from "./contract.ts"

/*
 * `any` stands for each block's own props, output keys and services. A
 * block's props type appears both in what it accepts and in what it returns,
 * so no other type admits every block.
 */
/** A block of any class. */
export type AnyBlock =
  | DisplayBlock<any>
  | FormBlock<any, any>
  | TaskBlock<any, any, any>
  | CredentialBlock<any>

/** What a registry line names: a block, or an alias of one. */
export type Entry = AnyBlock | Alias<any>

/** MDX tag to entry. */
export type Registry = { readonly [tag: string]: Entry }

export const isAlias = (entry: Entry): entry is Alias<unknown> => !("class" in entry)

/** The decoded props of a block or alias. */
export type PropsOf<E> = E extends { readonly props: Schema.Codec<infer P, unknown> }
  ? P
  : E extends Alias<infer P>
    ? P
    : never

/** The tags that name a block, not an alias. */
export type BlockTags<R extends Registry> = {
  [T in keyof R]: R[T] extends AnyBlock ? T : never
}[keyof R] &
  string

/** The tags of `R`'s blocks of class `C`. */
export type TagsOfClass<R extends Registry, C extends BlockClass> = {
  [T in BlockTags<R>]: R[T] extends { readonly class: C } ? T : never
}[BlockTags<R>]

/**
 * The services every block in `R` needs. The app's and the CLI's layers must
 * provide all of them, so a block that needs a new service fails the build
 * of each client until it does.
 */
export type ServicesOf<R extends Registry> = {
  [T in BlockTags<R>]: R[T] extends FormBlock<any, infer S>
    ? S
    : R[T] extends TaskBlock<any, any, infer S>
      ? S
      : never
}[BlockTags<R>]

/** A tag resolved to its block, with the props an alias locks. */
export interface Resolved {
  /** The tag as written. */
  readonly tag: string
  readonly block: AnyBlock
  /** Empty for a block's own tag. */
  readonly locked: Readonly<Record<string, unknown>>
}

/** The block a tag names, through an alias if need be. `undefined` for an unknown tag. */
export function resolveTag(registry: Registry, tag: string): Resolved | undefined {
  if (!Object.hasOwn(registry, tag)) return undefined
  const entry = registry[tag]!
  if (!isAlias(entry)) return { tag, block: entry, locked: {} }
  const target = Object.hasOwn(registry, entry.of) ? registry[entry.of] : undefined
  if (target === undefined || isAlias(target)) return undefined
  return { tag, block: target, locked: entry.locked as Readonly<Record<string, unknown>> }
}

/** What is wrong with a registry. Empty when nothing is. */
export function registryProblems(registry: Registry): ReadonlyArray<string> {
  return Object.entries(registry).flatMap(([tag, entry]) => {
    const problems: string[] = []
    if (entry.name !== tag) problems.push(`${tag}: its entry is named ${entry.name}`)
    if (!/^[A-Z][A-Za-z0-9]*$/.test(tag)) problems.push(`${tag}: a tag is PascalCase`)
    if (!/^\d+\.\d+\.\d+$/.test(entry.since))
      problems.push(`${tag}: since ${entry.since} is not a version`)
    if (isAlias(entry)) {
      const target = Object.hasOwn(registry, entry.of) ? registry[entry.of] : undefined
      if (target === undefined)
        problems.push(`${tag}: aliases ${entry.of}, which is not in the registry`)
      else if (isAlias(target)) problems.push(`${tag}: aliases ${entry.of}, which is an alias`)
    }
    return problems
  })
}
