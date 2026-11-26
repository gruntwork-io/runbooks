/**
 * The window's Content-Security-Policy, which main sets as a response
 * header (main.ts), where the page can't loosen it.
 *
 * A build's page may run the bundle's scripts, load the bundle's
 * stylesheet, load images and media from the open runbooks' assets
 * (`runbook-asset:`, runbookAssets.ts), and load nothing else: no inline or
 * evaluated script, no inline style, no image or media from elsewhere, no
 * font, frame, plugin or network request, no `<base>`, and no form
 * submission. 'self' is the page's own origin,
 * `runbooks-app://window` (pageScheme.ts), so no file:// URL is 'self'.
 *
 * Without 'unsafe-inline', a `<style>` element or a `style` attribute in
 * markup is refused, but a style set through the CSSOM (`element.style`),
 * as React sets its `style` props, applies. A `url()` in such a style loads
 * no font, and an image only from a runbook's assets.
 *
 * On electron-vite's dev server the policy is the same, plus what the dev
 * server needs. Vite tags each script and style it puts in the page, the
 * React refresh preamble among them, with `DEV_SERVER_NONCE`
 * (electron.vite.app.config.ts sets html.cspNonce in dev only), and its
 * client talks to the server over a WebSocket for hot updates. The nonce
 * is fixed, so it is no secret: in dev the policy catches what a build's
 * would refuse, and guards no more than that.
 */

import { ASSET_SCHEME } from "./schemes.ts"

/** The nonce Vite's dev server tags its scripts and styles with. */
export const DEV_SERVER_NONCE = "runbooksDevServer"

/** The policy for the build's page, or for the dev server's at `devServer`. */
export function contentSecurityPolicy(devServer: URL | undefined): string {
  const tagged = devServer === undefined ? "" : ` 'nonce-${DEV_SERVER_NONCE}'`
  const socket =
    devServer === undefined
      ? []
      : [`connect-src 'self' ${devServer.protocol === "https:" ? "wss" : "ws"}://${devServer.host}`]
  return [
    "default-src 'none'",
    `script-src 'self'${tagged}`,
    `style-src 'self'${tagged}`,
    `img-src ${ASSET_SCHEME}:`,
    `media-src ${ASSET_SCHEME}:`,
    ...socket,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}
