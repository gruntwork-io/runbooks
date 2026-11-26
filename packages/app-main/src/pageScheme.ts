/**
 * The window's page, from a scheme of its own: `runbooks-app://window/`,
 * whose root is the renderer's build (app-out/renderer/).
 *
 * The page is an origin of its own, so the CSP's 'self' is that origin and
 * nothing else. On a file:// page Chromium counts every file:// URL as
 * 'self', so a script or stylesheet at any local path would load.
 *
 * - The scheme is `runbooks-app`, the app's own name, apart from
 *   `runbook-asset` (a runbook's files) and from any scheme the OS may one
 *   day hand the app a link with.
 * - Its one host is `window`, as the window's session is named: the page
 *   is the window's, and no other page has this origin.
 * - Main registers it standard, so the page has an origin and its relative
 *   URLs resolve, and secure, so it is a secure context. It serves it on the
 *   window's session only (main.ts).
 * - Only files under the build are served, through the path guard
 *   (pathGuard.ts).
 */
import { Effect } from "effect"
import type { FileSystem } from "@runbooks/core/services/FileSystem"
import { servedFile } from "./pathGuard.ts"

/** The scheme main serves the renderer's build from. */
export const PAGE_SCHEME = "runbooks-app"

/** The scheme's one host. */
const PAGE_HOST = "window"

/** The page the window loads in a build. */
export const APP_PAGE = new URL(`${PAGE_SCHEME}://${PAGE_HOST}/index.html`)

/**
 * The file in the renderer's build, `root`, that `requestUrl` names, or
 * undefined when it names none: another scheme or host, or a path the
 * path guard refuses.
 */
export const pageFile = (
  requestUrl: string,
  root: string,
): Effect.Effect<string | undefined, never, FileSystem> => {
  const url = URL.parse(requestUrl)
  if (url === null || url.protocol !== `${PAGE_SCHEME}:` || url.hostname !== PAGE_HOST)
    return Effect.succeed(undefined)
  return servedFile(url, root)
}
