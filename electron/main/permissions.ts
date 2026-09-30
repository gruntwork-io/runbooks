/**
 * Browser permissions for the app's session.
 *
 * Electron grants every permission request unless a handler says otherwise,
 * and Chromium then asks the OS. A page framed by the Iframe block could
 * therefore raise a macOS microphone prompt attributed to Runbooks, and once
 * the user allows it, every later request succeeds silently.
 */
import type { Session } from "electron"

// What the renderer itself uses: navigator.clipboard.writeText in copy buttons.
const APP_PERMISSIONS = new Set(["clipboard-sanitized-write"])

/**
 * Deny every permission except the ones the app's own main frame uses.
 * Frames never get a permission. The main window's main frame is always the
 * app, because its will-navigate handler blocks navigating it anywhere else.
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
