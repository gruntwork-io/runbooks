/**
 * Runbook asset URLs.
 *
 * A runbook references files in the `assets/` folder next to it as
 * `./assets/<file>`. The renderer is loaded from the app bundle, so such a URL
 * would resolve against the bundle; it is rewritten to
 * `runbook-asset://assets/<file>` instead, which Electron's protocol handler
 * (electron/main/index.ts) serves from the runbook's folder.
 *
 * Used by the MDX compiler's rehype plugin (MDXContainer) and by
 * InlineMarkdown (block titles, descriptions and messages), so both rewrite
 * the same tags and attributes.
 */

// The URL attributes, per HTML tag, that may reference a runbook asset. Only
// lowercase HTML tags are listed, so props on capitalized block components
// (<Command>, <Template>, ...) are never touched. <embed> and <object> are not
// listed: remarkLiteralOnly rejects them in the MDX, and markdown syntax can't
// produce them. A Map, so a tag named like an Object.prototype member can't match.
const ASSET_ATTRS = new Map<string, readonly string[]>([
  ['img', ['src']], // <img src="./assets/image.png">
  ['video', ['src', 'poster']], // <video src="./assets/video.mp4" poster="./assets/poster.png">
  ['audio', ['src']], // <audio src="./assets/audio.mp3">
  ['source', ['src']], // <source src="./assets/video.webm"> (child of video/audio)
  ['a', ['href']], // <a href="./assets/document.pdf">
])

// `./assets/a.png` -> `runbook-asset://assets/a.png`; any other URL unchanged.
function toRunbookAssetUrl(url: string): string {
  if (!url.startsWith('./assets/')) {
    return url
  }
  // Remove the ./ prefix and use the runbook-asset:// protocol
  return `runbook-asset://${url.substring('./'.length)}`
}

/**
 * The value `attribute` of a `tagName` element should have: a `./assets/` URL
 * in one of the attributes listed above becomes a `runbook-asset://` URL, and
 * anything else is returned unchanged.
 */
export function rewriteAssetUrl(tagName: string, attribute: string, value: string): string {
  return ASSET_ATTRS.get(tagName)?.includes(attribute) ? toRunbookAssetUrl(value) : value
}
