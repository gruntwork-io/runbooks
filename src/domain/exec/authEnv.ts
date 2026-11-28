/**
 * The env vars an auth block exports, by provider, and how a block's
 * `envFrom` prop turns the exports it names into the env its script runs
 * with.
 *
 * Each list holds every variable the provider's tools read a credential,
 * account or location from. A block's export sets the ones its sign-in has
 * values for, and a script that names the block in `envFrom` runs with the
 * others removed, so nothing from the environment the app started with, or
 * from another block, mixes with the block's sign-in.
 *
 * The renderer bundles this module directly, so it must stay free of imports.
 */

export const AWS_AUTH_ENV_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_SESSION_TOKEN",
] as const

/**
 * `GOOGLE_APPLICATION_CREDENTIALS` or an access token is the credential
 * itself. The rest pin the project, account, region and zone that gcloud,
 * the client libraries and the OpenTofu `google` provider each read under a
 * different name. The provider reads an inline key from `GOOGLE_CREDENTIALS`
 * or a `*_KEYFILE_JSON` variable before any of them, so those are cleared too.
 */
export const GOOGLE_AUTH_ENV_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_CLOUD_KEYFILE_JSON",
  "GCLOUD_KEYFILE_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "CLOUDSDK_ACTIVE_CONFIG_NAME",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_PROJECT",
  "CLOUDSDK_CORE_ACCOUNT",
  "GOOGLE_CLOUD_REGION",
  "CLOUDSDK_COMPUTE_REGION",
  "GOOGLE_REGION",
  "CLOUDSDK_COMPUTE_ZONE",
  "GOOGLE_ZONE",
] as const

export const AZURE_AUTH_ENV_VARS = [
  "AZURE_CONFIG_DIR",
  "AZURE_EXTENSION_DIR",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "ARM_TENANT_ID",
  "ARM_SUBSCRIPTION_ID",
  "ARM_USE_CLI",
  "ARM_CLIENT_ID",
  "ARM_CLIENT_SECRET",
  "ARM_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_AUTH_TYPE",
  "AZURE_PRINCIPAL_NAME",
  "AZURE_PRINCIPAL_OBJECT_ID",
  "AZURE_PRINCIPAL_TYPE",
] as const

/** gh reads GH_TOKEN before GITHUB_TOKEN, and the enterprise tokens for a GHES host. */
export const GITHUB_AUTH_ENV_VARS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_USER",
  "GITHUB_HOST",
  "GH_HOST",
] as const

/** glab reads GITLAB_ACCESS_TOKEN and OAUTH_TOKEN too, and GL_HOST for its host. */
export const GITLAB_AUTH_ENV_VARS = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "GITLAB_USER",
  "GITLAB_HOST",
  "GL_HOST",
] as const

export type AuthProvider = "aws" | "google" | "azure" | "github" | "gitlab"

/** Every variable a provider's export controls, by provider. */
export const AUTH_EXPORT_VARS: Readonly<Record<AuthProvider, readonly string[]>> = {
  aws: AWS_AUTH_ENV_VARS,
  google: GOOGLE_AUTH_ENV_VARS,
  azure: AZURE_AUTH_ENV_VARS,
  github: GITHUB_AUTH_ENV_VARS,
  gitlab: GITLAB_AUTH_ENV_VARS,
}

/**
 * What a block exports for `envFrom`: the variables its sign-in set, and the
 * ones a script that names it runs without.
 */
export interface EnvExport {
  readonly env: Readonly<Record<string, string>>
  readonly clears: readonly string[]
}

/**
 * The export of a `provider` sign-in that set `env`. Fails, naming them, when
 * `env` has a variable the provider's list doesn't, so no caller can export
 * PATH, BASH_ENV, LD_PRELOAD or RUNBOOK_OUTPUT.
 */
export function authEnvExport(
  provider: AuthProvider,
  env: Readonly<Record<string, string>>,
):
  | { readonly ok: true; readonly export: EnvExport }
  | { readonly ok: false; readonly error: string } {
  const vars = AUTH_EXPORT_VARS[provider]
  const allowed = new Set(vars)
  const refused = Object.keys(env)
    .filter((name) => !allowed.has(name))
    .sort()
  if (refused.length > 0) {
    return { ok: false, error: `A ${provider} sign-in can't export ${refused.join(", ")}` }
  }
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""))
  return { ok: true, export: { env: set, clears: vars.filter((name) => set[name] === undefined) } }
}

/**
 * `base` with each of `exports` applied in order: the variables an export
 * clears are removed, then the ones it sets are set, so a later export wins
 * over an earlier one.
 */
export function applyEnvExports(
  base: Readonly<Record<string, string>>,
  exports: readonly EnvExport[],
): Record<string, string> {
  const env = { ...base }
  for (const { env: set, clears } of exports) {
    for (const name of clears) delete env[name]
    Object.assign(env, set)
  }
  return env
}
