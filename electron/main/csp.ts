/**
 * The renderer's production Content-Security-Policy.
 *
 * `img-src` allows the avatar hosts of the Git providers the auth blocks
 * show: github.com's (avatars.githubusercontent.com), every ghe.com tenant's
 * (`avatars.<sub>.ghe.com`), gitlab.com and gravatar. A GitHub Enterprise
 * Server instance serves avatars from its own origin (`https://<host>/avatars`)
 * or, with subdomain isolation, from `https://avatars.<host>` — so each GHES
 * host the user has configured is allowed explicitly. The CSP is fixed when a
 * frame loads, so a host first used mid-session gets its avatars on the next
 * load (the block falls back to no avatar until then).
 */
import { githubHostKind, tryNormalizeGitHubHost } from "../../src/domain/git/github-host.ts"

const BASE_IMG_SOURCES = [
  "'self'",
  "data:",
  "runbook-asset:",
  "https://avatars.githubusercontent.com",
  "https://*.ghe.com",
  "https://gitlab.com",
  "https://secure.gravatar.com",
]

/** img-src origins for the given GitHub hosts (only GHES hosts need any). */
export function githubImageOrigins(hosts: Iterable<string>): string[] {
  const origins = new Set<string>()
  for (const raw of hosts) {
    // Strict parse: only a clean host ever reaches the policy string.
    const host = tryNormalizeGitHubHost(raw)
    if (!host || githubHostKind(host) !== "ghes") continue
    origins.add(`https://${host}`)
    origins.add(`https://avatars.${host}`)
  }
  return [...origins]
}

export function buildContentSecurityPolicy(githubHosts: Iterable<string> = []): string {
  const imgSrc = [...BASE_IMG_SOURCES, ...githubImageOrigins(githubHosts)].join(" ")
  return (
    "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    `img-src ${imgSrc}; media-src 'self' runbook-asset:; font-src 'self' data:`
  )
}
