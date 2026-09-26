/**
 * Persisted GitLab and GitHub host picks:
 * `app.getPath("userData")/vcs-auth.json` holding
 *   { recentGitLabHosts: string[]; lastSelectedGitLabHost?: string;
 *     recentGitHubHosts: string[]; lastSelectedGitHubHost?: string }
 *
 * HOSTNAMES ONLY — never tokens. `recentGitLabHosts` is
 * most-recent-first, max 5, evicted from the tail; appended when a
 * manually-typed instanceUrl validates successfully. `lastSelectedGitLabHost`
 * is written on every successful GitLab auth and every explicit dropdown pick
 * (any source, not just manual URLs) — this is what makes a pick survive
 * restart. The GitHub pair follows the same rules; `recentGitHubHosts` gains
 * an enterprise host whenever a credential validates for it, which also lets
 * the window CSP allow that instance's avatars on the next load.
 */
import { app } from "electron"
import * as fs from "fs"
import * as path from "path"

const MAX_RECENT_HOSTS = 5

export interface VcsAuthStore {
  recentGitLabHosts: string[]
  lastSelectedGitLabHost?: string
  recentGitHubHosts: string[]
  lastSelectedGitHubHost?: string
}

const storePath = (): string => path.join(app.getPath("userData"), "vcs-auth.json")

const emptyStore = (): VcsAuthStore => ({ recentGitLabHosts: [], recentGitHubHosts: [] })

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((h): h is string => typeof h === "string") : []

/** Tolerant read: a missing or corrupt file is an empty store, never an error. */
export function readVcsAuthStore(): VcsAuthStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<VcsAuthStore> | null
    if (!parsed || typeof parsed !== "object") return emptyStore()
    return {
      recentGitLabHosts: stringList(parsed.recentGitLabHosts),
      lastSelectedGitLabHost:
        typeof parsed.lastSelectedGitLabHost === "string" ? parsed.lastSelectedGitLabHost : undefined,
      recentGitHubHosts: stringList(parsed.recentGitHubHosts),
      lastSelectedGitHubHost:
        typeof parsed.lastSelectedGitHubHost === "string" ? parsed.lastSelectedGitHubHost : undefined,
    }
  } catch {
    return emptyStore()
  }
}

function writeVcsAuthStore(store: VcsAuthStore): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2))
  } catch {
    // Persistence is best-effort; a read-only userData dir must never break auth.
  }
}

export function addRecentGitLabHost(host: string): void {
  const store = readVcsAuthStore()
  const next = [host, ...store.recentGitLabHosts.filter((h) => h !== host)].slice(0, MAX_RECENT_HOSTS)
  writeVcsAuthStore({ ...store, recentGitLabHosts: next })
}

export function setLastSelectedGitLabHost(host: string): void {
  const store = readVcsAuthStore()
  if (store.lastSelectedGitLabHost === host) return
  writeVcsAuthStore({ ...store, lastSelectedGitLabHost: host })
}

export function addRecentGitHubHost(host: string): void {
  const store = readVcsAuthStore()
  if (store.recentGitHubHosts[0] === host) return
  const next = [host, ...store.recentGitHubHosts.filter((h) => h !== host)].slice(0, MAX_RECENT_HOSTS)
  writeVcsAuthStore({ ...store, recentGitHubHosts: next })
}

export function setLastSelectedGitHubHost(host: string): void {
  const store = readVcsAuthStore()
  if (store.lastSelectedGitHubHost === host) return
  writeVcsAuthStore({ ...store, lastSelectedGitHubHost: host })
}
