/**
 * Secret redaction: one `redactSecrets(s)` applied
 * to all logged CLI stdout/stderr, every error message crossing IPC, and
 * makeLogger output.
 *
 * Three layers, applied in order:
 *  1. Exact-match removal of registered token VALUES (session-env tokens and
 *     the ambient token env vars) — the only safe way to catch GitLab's
 *     unprefixed 64-hex OAuth tokens.
 *  2. The git URL credential scrubber ((x-access-token|oauth2):<secret>@).
 *  3. Token shape regexes (the gh_, github_pat_, and glpat- prefix families).
 */

/**
 * Every ambient token env var across providers — the single statement of the
 * list. The redaction registration and the child-env strip tables (e.g.
 * the cold-read child) both read it; gitlab/auth.ts keeps its own
 * glab-precedence-ordered subset.
 */
export const VCS_TOKEN_ENV_VARS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
] as const

const knownSecrets = new Set<string>()

/** Minimum length guard so a degenerate value can't redact everything. */
const MIN_SECRET_LENGTH = 8

/**
 * Register a token VALUE for exact-match redaction. Called wherever main
 * learns a token: launch-time env reads, detection results, PAT entry, and
 * OAuth completion. Values only — never logged, never enumerable from
 * outside this module.
 */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) {
    knownSecrets.add(value)
  }
}

/** Exposed for tests only. */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear()
}

const URL_CREDENTIAL_PATTERN = /(?:x-access-token|oauth2):[^@\s]+@/g
const SHAPE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_\w{20,}/g,
  /glpat-[\w-]{15,}/g,
]

export function redactSecrets(input: string): string {
  let output = input
  for (const secret of knownSecrets) {
    if (output.includes(secret)) {
      output = output.split(secret).join("[REDACTED]")
    }
  }
  output = output.replace(URL_CREDENTIAL_PATTERN, "[REDACTED]@")
  for (const pattern of SHAPE_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]")
  }
  return output
}
