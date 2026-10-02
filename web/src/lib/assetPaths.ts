/**
 * Runbook asset URLs.
 *
 * A runbook references files in the `assets/` folder next to it as
 * `./assets/<file>`. The renderer is loaded from the app bundle, so such a URL
 * would resolve against the bundle; it is rewritten to
 * `runbook-asset://<host>/<file>` instead, which Electron's protocol handler
 * (electron/main/index.ts) serves from the runbook's assets/ folder. `<host>`
 * is the open runbook's, from runbook:get: each runbook gets its own, so
 * pages that the Iframe block frames from different runbooks have different
 * origins and never share storage. Without a host, URLs are left as written.
 *
 * Used by the MDX compiler's rehype plugin (MDXContainer) and by
 * InlineMarkdown (block titles, descriptions and messages), so both rewrite
 * the same tags and attributes.
 */

// The URL attributes, per HTML tag, that may reference a runbook asset, stored
// lowercased (hast spells them `srcSet`, JSX as the author wrote them). Only
// lowercase HTML tags are listed, so props on capitalized block components
// (<Command>, <Template>, ...) are never touched. <embed> and <object> are not
// listed: remarkLiteralOnly rejects them in the MDX, and markdown syntax can't
// produce them. A Map, so a tag named like an Object.prototype member can't match.
const ASSET_ATTRS = new Map<string, readonly string[]>([
  ["img", ["src", "srcset"]], // <img src="./assets/image.png" srcSet="./assets/image@2x.png 2x">
  ["video", ["src", "poster"]], // <video src="./assets/video.mp4" poster="./assets/poster.png">
  ["audio", ["src"]], // <audio src="./assets/audio.mp3">
  // <source src="./assets/video.webm"> in <video>/<audio>, <source srcSet="./assets/image.webp"> in <picture>
  ["source", ["src", "srcset"]],
  ["track", ["src"]], // <track src="./assets/captions.vtt"> (child of video/audio)
  ["a", ["href"]], // <a href="./assets/document.pdf">
])

/**
 * `./assets/a.png` -> `runbook-asset://<host>/a.png`; any other URL unchanged.
 * Only the prefix changes, so anything after the URL (a srcset descriptor) is kept.
 */
export function toRunbookAssetUrl(url: string, host: string | undefined): string {
  if (!host || !url.startsWith("./assets/")) {
    return url
  }
  return `runbook-asset://${host}/${url.substring("./assets/".length)}`
}

// A srcset is comma-separated candidates, each a URL with an optional
// descriptor: "./assets/a.png 1x, ./assets/a@2x.png 2x". Rewrites the URL that
// starts each candidate and keeps the descriptor and whitespace. A comma
// inside a URL (data:...;base64,...) splits it too, but only a piece that
// starts with ./assets/ changes.
function toRunbookAssetSrcSet(srcSet: string, host: string | undefined): string {
  return srcSet
    .split(",")
    .map((candidate) => {
      const url = candidate.trimStart()
      return candidate.slice(0, candidate.length - url.length) + toRunbookAssetUrl(url, host)
    })
    .join(",")
}

/**
 * The value `attribute` of a `tagName` element should have: a `./assets/` URL
 * in one of the attributes listed above (matched case-insensitively) becomes a
 * `runbook-asset://<host>/` URL, as does each such candidate in a srcset, and
 * anything else is returned unchanged.
 */
export function rewriteAssetUrl(
  tagName: string,
  attribute: string,
  value: string,
  host: string | undefined,
): string {
  const name = attribute.toLowerCase()
  if (!ASSET_ATTRS.get(tagName)?.includes(name)) {
    return value
  }
  return name === "srcset" ? toRunbookAssetSrcSet(value, host) : toRunbookAssetUrl(value, host)
}
