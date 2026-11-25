/**
 * Allowlist for the `{env:{prefix}}` detectCredentials variant shared by the
 * auth blocks, enforced in MAIN (the renderer-supplied prefix is untrusted
 * input) before any env var name is built from it.
 */
export const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/
