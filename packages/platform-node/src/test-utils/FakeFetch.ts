/**
 * A typed stand-in for `fetch` that answers every request with `respond`.
 * Bun's `fetch` also carries `preconnect`, which no test calls, so the fake's
 * is a no-op.
 */
export function makeFakeFetch(
  respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(respond, { preconnect: () => {} })
}
