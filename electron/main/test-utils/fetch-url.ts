/**
 * The URL a fetch() call targets, for fetch mocks. String() on a Request gives
 * "[object Request]", so read its url instead.
 */
export function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}
