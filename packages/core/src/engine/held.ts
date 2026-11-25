/**
 * A value the session holds for a block: an output, or a form field's value.
 * A sensitive one stays redacted inside the engine too, and every view and
 * event shows it `Hidden`. Only the block that reads it gets it in clear.
 */
import { Redacted } from "effect"

export type Held<A> =
  | { readonly sensitive: false; readonly value: A }
  | { readonly sensitive: true; readonly value: Redacted.Redacted<A> }

export const hold = <A>(sensitive: boolean, value: A): Held<A> =>
  sensitive ? { sensitive, value: Redacted.make(value) } : { sensitive, value }

/** What a client is shown of it. */
export const visible = <A>(
  held: Held<A>,
): { readonly _tag: "Shown"; readonly value: A } | { readonly _tag: "Hidden" } =>
  held.sensitive ? { _tag: "Hidden" } : { _tag: "Shown", value: held.value }

/** The value itself, for the block that reads it. Never for a view or an event. */
export const reveal = <A>(held: Held<A>): A =>
  held.sensitive ? Redacted.value(held.value) : held.value
