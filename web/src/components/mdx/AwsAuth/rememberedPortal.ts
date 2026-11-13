import type { SsoPortal } from "./utils"

const STORAGE_KEY = "runbooks:aws-sso-portal"
const EVENT = "runbooks:aws-sso-portal"

/**
 * The access portal an <AwsAuth> block last signed in to on this computer, so
 * a runbook that sets no `ssoStartUrl` needn't have it typed again. Nothing
 * when storage is unavailable or holds something else.
 */
export function readRememberedPortal(): SsoPortal | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown
    if (
      stored &&
      typeof stored === "object" &&
      typeof (stored as SsoPortal).startUrl === "string" &&
      typeof (stored as SsoPortal).region === "string" &&
      (stored as SsoPortal).startUrl !== ""
    ) {
      return { startUrl: (stored as SsoPortal).startUrl, region: (stored as SsoPortal).region }
    }
  } catch {
    // Storage unavailable, or not JSON: remember nothing.
  }
  return undefined
}

/** Remembers a portal that signed in, and tells the page's other blocks. */
export function rememberPortal(portal: SsoPortal): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portal))
  } catch {
    // Storage unavailable: the page's other blocks still hear of it.
  }
  window.dispatchEvent(new CustomEvent<SsoPortal>(EVENT, { detail: portal }))
}

/** Calls `listener` with each portal a block on the page signs in to. Returns the unsubscribe. */
export function onPortalRemembered(listener: (portal: SsoPortal) => void): () => void {
  const handle = (e: Event) => listener((e as CustomEvent<SsoPortal>).detail)
  window.addEventListener(EVENT, handle)
  return () => window.removeEventListener(EVENT, handle)
}
