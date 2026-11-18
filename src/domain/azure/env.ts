import type { AZURE_AUTH_ENV_VARS } from "../exec/authEnv.ts"
import type { AzurePrincipal } from "./claims.ts"

export type AzureAuthType = "cli" | "device_code" | "service_principal"

type AzureEnvVar = (typeof AZURE_AUTH_ENV_VARS)[number]

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

export const AZURE_SECRET_ENV_VARS = ["ARM_CLIENT_SECRET", "AZURE_CLIENT_SECRET"] as const

export function azureSessionEnv(input: {
  readonly authType: AzureAuthType
  readonly configDir: string
  readonly extensionDir?: string | undefined
  readonly principal: AzurePrincipal
  readonly tenantId: string
  readonly subscriptionId?: string | undefined
  readonly clientId?: string | undefined
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}): { set: Partial<Record<AzureEnvVar, string>>; clear: AzureEnvVar[] } {
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
  }
  if (input.authType === "service_principal" && input.clientSecret) {
    set.ARM_CLIENT_SECRET = input.clientSecret
    set.AZURE_CLIENT_SECRET = input.clientSecret
  } else {
    set.ARM_USE_CLI = "true"
    if (input.certificatePath) set.AZURE_CLIENT_CERTIFICATE_PATH = input.certificatePath
  }
  const clear = AZURE_CREDENTIAL_ENV_VARS.filter((name) => set[name] === undefined)
  return { set, clear }
}
