/**
 * Browser permissions and client certificates for the app's session.
 *
 * Electron grants every permission request unless a handler says otherwise,
 * and Chromium then asks the OS. A page framed by the Iframe block could
 * therefore raise a macOS microphone prompt attributed to Runbooks, and once
 * the user allows it, every later request succeeds silently.
 */
import type { App, Session } from "electron"

// What the renderer itself uses: navigator.clipboard.writeText in copy
// buttons, and fullscreen for the fullscreen button of <video controls>.
const APP_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"])

/**
 * Deny every permission except the ones the app's own main frame uses.
 * Frames never get a permission, fullscreen included, so a framed page can't
 * cover the screen with its own content. The main window's main frame is
 * always the app, because its will-navigate handler blocks navigating it
 * anywhere else.
 */
export function installPermissionHandlers(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(isAllowed(permission, details.isMainFrame))
  })
  session.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    isAllowed(permission, details.isMainFrame),
  )
}

function isAllowed(permission: string, isMainFrame: boolean): boolean {
  return isMainFrame && APP_PERMISSIONS.has(permission)
}

/**
 * Send no client certificate. Electron's default presents the first
 * certificate in the OS store to any server that asks for one, and a page
 * framed by the Iframe block can make any server ask, which identifies the
 * user to it. Only requests made through Chromium (pages, frames, net.fetch)
 * ask here; the SDK and git calls, which run in Node, never do.
 */
export function installClientCertificateHandler(app: App): void {
  app.on("select-client-certificate", (event, _webContents, _url, _certificates, callback) => {
    event.preventDefault()
    callback()
  })
}
