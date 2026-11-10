/**
 * What a module source address names, for showing it briefly: the module's
 * name, the ref it's pinned to, and its page on GitHub when it lives there.
 */

export interface ModuleSourceInfo {
  /** The module's folder name, or the repository's when the module is at its root. */
  readonly name: string
  readonly ref?: string
  /** The module's folder on GitHub, at its ref. */
  readonly url?: string
}

/** A GitHub repository in a source's address: https, scp-like, or scheme-less. */
const GITHUB = /^(?:https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/

/**
 * Reads a module source such as
 * `git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0`.
 */
export function moduleSourceInfo(source: string): ModuleSourceInfo {
  const [address = "", query = ""] = source.replace(/^git::/, "").split("?", 2)
  const ref = new URLSearchParams(query).get("ref") ?? undefined
  // `//` after the scheme's own separates the repository from the module's folder in it.
  const schemeEnd = address.indexOf("://")
  const split = address.indexOf("//", schemeEnd === -1 ? 0 : schemeEnd + 3)
  const repo = split === -1 ? address : address.slice(0, split)
  const folder = split === -1 ? "" : address.slice(split + 2).replace(/^\/+|\/+$/g, "")
  const repoName =
    repo
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .filter(Boolean)
      .at(-1) ?? source
  const name = folder ? folder.split("/").at(-1)! : repoName
  const github = GITHUB.exec(repo)
  const url = github
    ? `https://github.com/${github[1]}/${github[2]}${folder || ref ? `/tree/${ref ?? "HEAD"}` : ""}${folder ? `/${folder}` : ""}`
    : undefined
  return { name, ...(ref ? { ref } : {}), ...(url ? { url } : {}) }
}
