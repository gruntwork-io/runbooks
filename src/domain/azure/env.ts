/**
 * The env vars an AzureAuth sign-in gives scripts.
 *
 * Pure. Main writes `env` to the session (and deletes `clear`); the block
 * publishes `env` as its outputs, and an `azureAuthId` step gets them for its
 * run only (see web/src/components/mdx/_shared/hooks/useScriptExecution.ts).
 */
import type { AZURE_AUTH_ENV_VARS } from "../exec/authEnv.ts"
import type { AzurePrincipal } from "./claims.ts"

/** How the block signed in, as AZURE_AUTH_TYPE gives it. */
export type AzureAuthType = "cli" | "device_code" | "service_principal"

type AzureEnvVar = (typeof AZURE_AUTH_ENV_VARS)[number]

/** A block's sign-in, as far as its env vars need it. */
export interface AzureSignInEnvInput {
  readonly authType: AzureAuthType
  readonly configDir: string
  /** Where az finds extensions; the config dir's own when unset. */
  readonly extensionDir?: string | undefined
  readonly principal: AzurePrincipal
  readonly tenantId: string
  readonly subscriptionId?: string | undefined
  /** Service principal only. */
  readonly clientId?: string | undefined
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}

/**
 * The vars a step must not inherit from ANOTHER AzureAuth block. A step that
 * names this block gets each of them, blank when this block has no value, so
 * a client secret another block left in the session can't take precedence
 * over this block's sign-in (azurerm prefers a client secret to the CLI).
 */
export const AZURE_CREDENTIAL_ENV_VARS = [
  "AZURE_SUBSCRIPTION_ID",
  "ARM_SUBSCRIPTION_ID",
  "ARM_USE_CLI",
  "ARM_CLIENT_ID",
  "ARM_CLIENT_SECRET",
  "ARM_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
] as const satisfies readonly AzureEnvVar[]

/** The vars that hold a secret: published as sensitive outputs. */
export const AZURE_SECRET_ENV_VARS = ["ARM_CLIENT_SECRET", "AZURE_CLIENT_SECRET"] as const

/** A session-env change: keys to set, then keys to delete. */
export interface AzureSessionEnvChange {
  readonly set: Partial<Record<AzureEnvVar, string>>
  readonly clear: readonly AzureEnvVar[]
}

/**
 * The env vars for a sign-in. Nothing is written empty: a key this sign-in has
 * no value for goes in `clear`, so the session doesn't keep another block's.
 *
 * Every sign-in, a service principal's included, lives in the block's
 * `AZURE_CONFIG_DIR`, so a bare `az` uses it. OpenTofu's `azurerm` and
 * `azuread` read the CLI's sign-in when `ARM_USE_CLI` is true, which is how a
 * user signs them in. A service principal with a secret passes it as
 * ARM_CLIENT_SECRET (and AZURE_CLIENT_SECRET for the Azure SDKs). One with a
 * certificate passes its path; `az` takes a PEM file, and `azurerm` reads
 * ARM_CLIENT_CERTIFICATE_PATH only as PKCS#12, so for a PEM it also gets
 * ARM_USE_CLI to fall back to the CLI's sign-in.
 */
export function azureSessionEnv(input: AzureSignInEnvInput): AzureSessionEnvChange {
  const set: Partial<Record<AzureEnvVar, string>> = {
    AZURE_CONFIG_DIR: input.configDir,
    AZURE_EXTENSION_DIR: input.extensionDir ?? `${input.configDir}/cliextensions`,
    AZURE_TENANT_ID: input.tenantId,
    ARM_TENANT_ID: input.tenantId,
    AZURE_AUTH_TYPE: input.authType,
    AZURE_PRINCIPAL_NAME: input.principal.name,
    AZURE_PRINCIPAL_OBJECT_ID: input.principal.objectId,
    AZURE_PRINCIPAL_TYPE: input.principal.type,
  }
  if (input.subscriptionId) {
    set.AZURE_SUBSCRIPTION_ID = input.subscriptionId
    set.ARM_SUBSCRIPTION_ID = input.subscriptionId
  }

  if (input.authType === "service_principal" && input.clientId) {
    set.ARM_CLIENT_ID = input.clientId
    set.AZURE_CLIENT_ID = input.clientId
    if (input.clientSecret) {
      set.ARM_CLIENT_SECRET = input.clientSecret
      set.AZURE_CLIENT_SECRET = input.clientSecret
    } else if (input.certificatePath) {
      set.AZURE_CLIENT_CERTIFICATE_PATH = input.certificatePath
      if (/\.(pfx|p12)$/i.test(input.certificatePath)) {
        set.ARM_CLIENT_CERTIFICATE_PATH = input.certificatePath
      } else {
        set.ARM_USE_CLI = "true"
      }
    }
  } else {
    set.ARM_USE_CLI = "true"
  }

  const clear = AZURE_CREDENTIAL_ENV_VARS.filter((name) => set[name] === undefined)
  return { set, clear }
}
