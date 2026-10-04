import { useCallback, useContext, useEffect, useId, useState } from "react"
import { AlertCircle, ExternalLink, FileCode, Globe, RotateCw } from "lucide-react"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { RunbookContext } from "@/contexts/RunbookContext"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { runbookAssetOrigin, toRunbookAssetUrl } from "@/lib/assetPaths"
import { runbookStorageKey } from "@/components/mdx/_shared/lib/runbookStorageKey"
import { BlockIdLabel } from "@/components/mdx/_shared/components/BlockIdLabel"
import { ViewOutputs } from "@/components/mdx/_shared/components/ViewOutputs"
import { useFrameMessaging, type EmbedWebview } from "./hooks/useFrameMessaging"
import { OUTPUT_NAME } from "./protocol"

interface IframeProps {
  /** An https URL, an http URL on localhost or 127.0.0.1, or a path to a file in the runbook's assets folder (`./assets/site/index.html`). */
  src: string
  /** Label shown above the frame and read by screen readers. The frame's location is always shown next to it. */
  title?: string
  /** Frame height: a number of pixels (`600` or `"600"`), or any CSS length such as `"70vh"`. */
  height?: number | string
  /** Block id. Required with `outputs`: later blocks read the page's outputs as `{{ .outputs.<id>.<name> }}`. */
  id?: string
  /** Inputs blocks whose values a page from `./assets/` receives. */
  inputsId?: string | string[]
  /** Names of the outputs a page from `./assets/` may set. */
  outputs?: string[]
}

/**
 * Where the frame loads from, and what the title bar shows for it: the host of
 * an external URL, or the `./assets/` path. A local page also has `origin`,
 * its runbook's runbook-asset:// origin, which messages are exchanged with.
 */
type FrameSource =
  | { url: string; location: string; isLocal: false }
  | { url: string; location: string; isLocal: true; origin: string }
  | { error: string }

const DEFAULT_HEIGHT = 500
const NO_OUTPUTS: string[] = []

/**
 * Embeds a web page in the runbook: an external site, or an HTML file from
 * the runbook's assets folder together with the files it references.
 *
 * The page runs in a `<webview>`, not an iframe: a web contents of its own,
 * which can't take keyboard focus from the app's fields the way a cross-site
 * iframe can. The main process decides its session and locks it down before
 * it attaches (electron/main/embeds.ts).
 *
 * The page loads only after the user clicks Load, so opening a runbook runs
 * none of the author's scripts. The choice lasts until the app quits.
 *
 * A page from the assets folder can exchange values with the runbook (see
 * useFrameMessaging): it receives the values of the `inputsId` Inputs blocks,
 * and the outputs it sets become this block's outputs.
 */
export function Iframe({
  src,
  title,
  height = DEFAULT_HEIGHT,
  id,
  inputsId,
  outputs = NO_OUTPUTS,
}: IframeProps) {
  const componentId = useId()
  const { reportError, clearError } = useErrorReporting()
  // A block without an id registers under its unique React id, so it can
  // never collide with another block.
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id ?? componentId,
    "Iframe",
  )
  const runbook = useContext(RunbookContext)
  const loadedKey = runbookStorageKey("iframe-loaded", runbook?.storageScope, src)
  const [loaded, setLoaded] = useState(() => readLoaded(loadedKey))
  // Remounting the webview reloads it from `src`.
  const [loadCount, setLoadCount] = useState(0)
  // State, not a ref: each reload mounts a new webview, whose events the
  // messaging listens to.
  const [webview, setWebview] = useState<EmbedWebview | null>(null)
  const webviewRef = useCallback((element: HTMLWebViewElement | null) => {
    setWebview(element as EmbedWebview | null)
  }, [])
  const source = resolveSource(src, runbook?.assetHost)
  const cssHeight = toCssHeight(height)
  const error =
    "error" in source
      ? source.error
      : cssHeight === null
        ? `Invalid height "${height}". Use a number of pixels, such as {600} or "600", or a CSS length such as "70vh".`
        : (messagingConfigError(source.isLocal, id, inputsId, outputs) ??
          idError(id, isDuplicate, isNormalizedCollision, collidingId))
  const { outputs: pageOutputs, messageError } = useFrameMessaging({
    webview,
    pageOrigin: !error && "origin" in source ? source.origin : undefined,
    id,
    outputNames: outputs,
    inputsId,
  })

  useEffect(() => {
    if (error) {
      reportError({ componentId, componentType: "Iframe", severity: "error", message: error })
    } else {
      clearError(componentId)
    }
  }, [error, componentId, reportError, clearError])

  if (error || "error" in source || cssHeight === null) {
    return (
      <div className="runbook-block rounded-md border p-3 text-sm flex items-start gap-2 mb-5 bg-destructive-muted border-destructive/30 text-destructive">
        <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
        <div>
          <div className="text-md font-bold mb-1">Invalid Iframe</div>
          <p>{error}</p>
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
          {title && <span className="min-w-0 truncate font-medium text-foreground">{title}</span>}
          {/* The title gives way to the location, and a long location loses its
              start, not its end: rtl puts the ellipsis on the left, so the part
              of a host that names the site always shows
              (…signin.evil.example, not console.aws.amazon.com…). bdi keeps
              the text itself left-to-right. */}
          <span
            className="shrink-0 max-w-[70%] overflow-hidden text-ellipsis whitespace-nowrap text-left [direction:rtl] font-mono text-xs"
            title={source.url}
            data-testid="iframe-location"
          >
            <bdi dir="ltr">{source.location}</bdi>
          </span>
        </div>
        {id && <BlockIdLabel id={id} size="large" />}
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
        // Pages that set no background expect a white one, not the app's dark
        // theme. A webview lays out its page with display: flex, so leave
        // display alone.
        <webview
          key={loadCount}
          ref={webviewRef}
          src={source.url}
          title={title || source.location}
          className="w-full bg-white"
          style={{ height: cssHeight }}
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
      {(messageError || pageOutputs) && (
        <div className="border-t border-border px-3 py-2 text-sm">
          {messageError && (
            <p role="alert" className="m-0 text-destructive">
              {messageError}
            </p>
          )}
          {pageOutputs && <ViewOutputs outputs={pageOutputs} />}
        </div>
      )}
    </div>
  )
}

Iframe.displayName = "Iframe"

/** Why the messaging props don't fit this block, or undefined when they do. */
function messagingConfigError(
  isLocal: boolean,
  id: string | undefined,
  inputsId: string | string[] | undefined,
  outputs: unknown,
): string | undefined {
  if (!Array.isArray(outputs) || outputs.some((name) => typeof name !== "string")) {
    return 'The outputs prop must be a list of names, such as outputs={["region"]}.'
  }
  if (!isLocal && (inputsId !== undefined || outputs.length > 0)) {
    return "The inputsId and outputs props only work with a page from ./assets/. An external site can't exchange values with the runbook."
  }
  const invalid = outputs.find((name: string) => !OUTPUT_NAME.test(name))
  if (invalid !== undefined) {
    return `Output name "${invalid}" is invalid. Use letters, digits and underscores, starting with a letter or underscore.`
  }
  if (outputs.length > 0 && !id) {
    return "An Iframe with outputs needs an id. Later blocks read the outputs as {{ .outputs.<id>.<name> }}."
  }
  return undefined
}

function idError(
  id: string | undefined,
  isDuplicate: boolean,
  isNormalizedCollision: boolean,
  collidingId: string | undefined,
): string | undefined {
  if (!id) return undefined
  if (isDuplicate) return `Duplicate Iframe block ID: "${id}"`
  if (isNormalizedCollision)
    return `Iframe ID "${id}" collides with "${collidingId}" after normalization`
  return undefined
}

// Hosts whose plain-http traffic never leaves the machine, so nothing on the
// network can rewrite the page. The main process allows the same
// (electron/main/embeds.ts).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"])

/**
 * The URL the frame loads for `src`, or why `src` is not allowed.
 *
 * Only https URLs, http URLs on a loopback host, and `./assets/` paths are
 * allowed. Each gives the frame an origin other than the app's: a file://
 * frame would share the app's origin and could reach `window.api` through
 * `parent`. An `./assets/` path loads from `assetHost`, the open runbook's
 * runbook-asset:// host, so it can't share an origin with another runbook's
 * pages either.
 */
function resolveSource(src: unknown, assetHost: string | undefined): FrameSource {
  if (typeof src !== "string" || src.trim() === "") {
    return { error: "The `src` prop is required." }
  }
  if (src.startsWith("./assets/")) {
    if (!assetHost) {
      return { error: `"${src}" can only be shown in an open runbook.` }
    }
    return {
      url: toRunbookAssetUrl(src, assetHost),
      location: src,
      isLocal: true,
      origin: runbookAssetOrigin(assetHost),
    }
  }

  const unsupported = {
    error: `Unsupported src "${src}". Use an https:// URL, an http:// URL on localhost or 127.0.0.1, or a path that starts with ./assets/ for a file in the runbook's assets folder.`,
  }
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return unsupported
  }
  const isLoopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    return unsupported
  }
  return { url: url.href, location: url.host, isLocal: false }
}

/**
 * `height` as a CSS height, or null if it isn't one. A number, or a string of
 * digits, is a pixel count, so `height="600"` means 600px as it does on an
 * HTML iframe instead of an invalid value the browser drops.
 */
function toCssHeight(height: number | string): string | null {
  if (typeof height === "number") {
    return Number.isFinite(height) && height > 0 ? `${height}px` : null
  }
  const value = String(height).trim()
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value) > 0 ? `${value}px` : null
  }
  // The browser's own parser decides what a CSS length is: it ignores a value it can't parse.
  const probe = document.createElement("div").style
  probe.height = value
  return probe.height === "" ? null : value
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
