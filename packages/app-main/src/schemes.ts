/**
 * The schemes main serves the window from, which main registers and the
 * window's CSP names. They import nothing, so the build's config can import
 * the CSP (electron.vite.app.config.ts).
 */

/** The renderer's build: the window's page (pageScheme.ts). */
export const PAGE_SCHEME = "runbooks-app"

/** The open runbooks' assets/ folders (runbookAssets.ts). */
export const ASSET_SCHEME = "runbook-asset"
