/**
 * `T` with every key that may hold undefined made optional and undefined
 * removed from its value, matching what {@link omitUndefined} returns.
 */
export type OmitUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}

/**
 * A copy of `obj` without the keys whose value is undefined. IPC payloads go
 * through structured clone, which keeps a key set to undefined, so an
 * optional field built from a possibly-undefined value is left out instead of
 * sent as present-but-undefined.
 */
export function omitUndefined<T extends object>(obj: T): OmitUndefined<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as OmitUndefined<T>
}
