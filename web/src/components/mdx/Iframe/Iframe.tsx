import { useContext, useEffect, useId, useState } from "react"
import { AlertCircle, ExternalLink, FileCode, Globe, RotateCw } from "lucide-react"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { RunbookContext } from "@/contexts/RunbookContext"
import { toRunbookAssetUrl } from "@/lib/assetPaths"
import { runbookStorageKey } from "@/components/mdx/_shared/lib/runbookStorageKey"

interface IframeProps {
  /** An http(s) URL, or a path to a file in the runbook's assets folder (`./assets/site/index.html`). */
  src: string
  /** Label shown above the frame and read by screen readers. The frame's location is always shown next to it. */
  title?: string
  /** Frame height: a number of pixels, or any CSS length such as `"70vh"`. */
  height?: number | string
}

/** Where the frame loads from, and what the title bar shows for it: the host of an external URL, or the `./assets/` path. */
type FrameSource = { url: string; location: string; isLocal: boolean } | { error: string }

const DEFAULT_HEIGHT = 500

// The frame's origin is never the app's (see resolveSource), so scripts and
// same-origin storage are safe to allow. Leaving out allow-top-navigation
// stops the page from navigating the app away. Popups reach the main
// process's window-open handler, which opens http(s) URLs in the browser.
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups"

/**
 * Embeds a web page in the runbook: an external site, or an HTML file from
 * the runbook's assets folder together with the files it references.
 *
 * The page loads only after the user clicks Load, so opening a runbook runs
 * none of the author's scripts. The choice lasts until the app quits.
 */
export function Iframe({ src, title, height = DEFAULT_HEIGHT }: IframeProps) {
  const componentId = useId()
  const { reportError, clearError } = useErrorReporting()
  const storageScope = useContext(RunbookContext)?.storageScope
  const loadedKey = runbookStorageKey("iframe-loaded", storageScope, src)
  const [loaded, setLoaded] = useState(() => readLoaded(loadedKey))
  // Remounting the iframe reloads it from `src`.
  const [loadCount, setLoadCount] = useState(0)
  const source = resolveSource(src)
  const error = "error" in source ? source.error : undefined

  useEffect(() => {
    if (error) {
      reportError({ componentId, componentType: "Iframe", severity: "error", message: error })
    } else {
      clearError(componentId)
    }
  }, [error, componentId, reportError, clearError])

  if ("error" in source) {
    return (
      <div className="runbook-block rounded-md border p-3 text-sm flex items-start gap-2 mb-5 bg-destructive-muted border-destructive/30 text-destructive">
        <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
        <div>
          <div className="text-md font-bold mb-1">Invalid Iframe</div>
          <p>{source.error}</p>
        </div>
      </div>
    )
  }

  const load = () => {
    writeLoaded(loadedKey)
    setLoaded(true)
  }
  const Icon = source.isLocal ? FileCode : Globe

  return (
    <div className="runbook-block mb-5 rounded-md border border-border overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-sm text-muted-foreground">
        <Icon className="size-4 flex-shrink-0" />
        <div className="flex flex-1 min-w-0 items-baseline gap-2">
          {title && <span className="truncate font-medium text-foreground">{title}</span>}
          <span className="truncate font-mono text-xs" title={source.url} data-testid="iframe-location">
            {source.location}
          </span>
        </div>
        {loaded && (
          <button
            type="button"
            onClick={() => setLoadCount((count) => count + 1)}
            className="flex-shrink-0 cursor-pointer hover:text-foreground transition-colors"
            aria-label="Reload"
            title="Reload"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {!source.isLocal && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 hover:text-foreground transition-colors"
            aria-label="Open in browser"
            title="Open in browser"
          >
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
      {loaded ? (
        // Pages that set no background expect a white one, not the app's dark theme.
        <iframe
          key={loadCount}
          src={source.url}
          title={title || source.location}
          sandbox={SANDBOX}
          className="block w-full bg-white"
          style={{ height }}
        />
      ) : (
        <div className="flex flex-col items-center gap-3 px-6 py-8 text-center text-sm text-muted-foreground">
          <p className="m-0">
            This page runs its own scripts. Load it only if you trust this runbook.
          </p>
          <button
            type="button"
            onClick={load}
            className="px-4 py-2 text-sm font-medium rounded-md border border-border bg-background text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            Load page
          </button>
        </div>
      )}
    </div>
  )
}

Iframe.displayName = "Iframe"

/**
 * The URL the frame loads for `src`, or why `src` is not allowed.
 *
 * Only http(s) URLs and `./assets/` paths are allowed. Either way the frame
 * gets an origin other than the app's: a file:// frame would share the app's
 * origin and could reach `window.api` through `parent`.
 */
function resolveSource(src: unknown): FrameSource {
  if (typeof src !== "string" || src.trim() === "") {
    return { error: "The `src` prop is required." }
  }
  if (src.startsWith("./assets/")) {
    return { url: toRunbookAssetUrl(src), location: src, isLocal: true }
  }

  const unsupported = {
    error: `Unsupported src "${src}". Use an http:// or https:// URL, or a path that starts with ./assets/ for a file in the runbook's assets folder.`,
  }
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return unsupported
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return unsupported
  }
  return { url: url.href, location: url.host, isLocal: false }
}

// sessionStorage, so the choice survives the remount that every live reload
// of the runbook causes but not an app restart.
function readLoaded(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "true"
  } catch {
    return false
  }
}

function writeLoaded(key: string): void {
  try {
    sessionStorage.setItem(key, "true")
  } catch {
    /* sessionStorage unavailable: the page stays loaded until the block remounts */
  }
}

export default Iframe
