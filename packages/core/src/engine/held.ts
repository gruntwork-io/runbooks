/**
 * A value the session holds for a block: an output, or a form field's value.
 * A sensitive one stays redacted inside the engine too, and every view and
 * event shows it `Hidden`. A block that reads it gets it redacted, as it
 * gets every value, and unwraps it itself.
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

/** The value itself, for the engine's own use. Never for a view, an event or a block. */
export const reveal = <A>(held: Held<A>): A =>
  held.sensitive ? Redacted.value(held.value) : held.value

/** The value redacted, sensitive or not, for a block that reads it. */
export const redacted = <A>(held: Held<A>): Redacted.Redacted<A> =>
  held.sensitive ? held.value : Redacted.make(held.value)
