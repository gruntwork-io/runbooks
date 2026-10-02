/**
 * The web pages the Iframe block embeds.
 *
 * Each page runs in a `<webview>` guest: a web contents of its own, in a
 * session of its own, rather than an iframe inside the app's page. A
 * cross-site iframe can move keyboard focus into itself without a click and
 * read what the user types into the app's fields; a guest can't take focus
 * from the app. A guest also has no preload, so no IPC surface, and its
 * session's permission, download and device handlers are its own.
 *
 * Local pages (the runbook's assets/, over runbook-asset://) and web pages
 * (https, and plain http on loopback hosts) get separate sessions. Only the
 * local one serves runbook-asset://, so a site the runbook embeds can't load
 * the runbook's assets.
 *
 * Only `import type` from electron, so this stays unit-testable without an
 * Electron runtime; main/index.ts and window.ts wire it up.
 */
import type { Event, Session, WebContents, WebPreferences } from "electron"

/** Session partitions of the two kinds of guest. `persist:` keeps sign-ins and storage across restarts. */
export const LOCAL_EMBED_PARTITION = "persist:embed-local"
export const WEB_EMBED_PARTITION = "persist:embed-web"

// Hosts whose plain-http traffic never leaves the machine, so nothing on the
// network can rewrite the page. The renderer's Iframe block accepts the same.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"])

/**
 * The partition a guest showing `url` belongs in, or null if no guest may
 * show it. A local page must be on `assetHost`, the open runbook's
 * runbook-asset:// host.
 */
export function embedPartitionFor(url: string, assetHost: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === "runbook-asset:") {
    return parsed.hostname === assetHost ? LOCAL_EMBED_PARTITION : null
  }
  if (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))
  ) {
    return WEB_EMBED_PARTITION
  }
  return null
}

/**
 * Prepare a `<webview>` that is about to attach (the main window's
 * will-attach-webview), or return false to refuse it. The tag only asks: the
 * session comes from its `src`, whatever `partition` it names, and whatever
 * preload, node integration or web preferences it names are overridden.
 * Runbook MDX can't write a `<webview>` (remarkLiteralOnly), so this guards
 * against a bug or a compromised renderer, not a runbook author.
 */
export function prepareWebviewAttach(
  webPreferences: WebPreferences,
  params: Record<string, string>,
  assetHost: string,
): boolean {
  const partition = embedPartitionFor(params.src ?? "", assetHost)
  if (!partition) return false
  delete webPreferences.preload
  Object.assign(webPreferences, {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableBlinkFeatures: "",
    plugins: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    // alert(), confirm() and prompt() would open native dialogs over the app.
    disableDialogs: true,
  } satisfies WebPreferences)
  params.partition = partition
  return true
}

/**
 * Deny everything a guest's session could ask for: permissions (camera,
 * notifications, fullscreen, clipboard...), USB/HID/serial devices, and
 * downloads, which would otherwise open a save dialog for any file a page
 * sends.
 */
export function installEmbedSession(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on("will-download", (event) => event.preventDefault())
}

/**
 * Keep a guest in its lane once it exists: no new windows (the handler can't
 * tell a click from a script, and would open the URL in the browser), no
 * main-frame navigation or redirect to a URL outside the guest's partition,
 * no `beforeunload` prompt holding the page open, and no Bluetooth device,
 * which Electron would otherwise pick for the page without asking.
 * `assetHost` returns the open runbook's host, which a local guest's
 * navigations must stay on.
 */
export function hardenEmbedGuest(
  guest: WebContents,
  partition: string,
  assetHost: () => string,
): void {
  guest.setWindowOpenHandler(() => ({ action: "deny" }))
  const stayInPartition = (event: Event<{ url: string; isMainFrame: boolean }>) => {
    if (event.isMainFrame && embedPartitionFor(event.url, assetHost()) !== partition) {
      event.preventDefault()
    }
  }
  guest.on("will-navigate", stayInPartition)
  guest.on("will-redirect", stayInPartition)
  guest.on("will-prevent-unload", (event) => event.preventDefault())
  guest.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault()
    callback("")
  })
}
