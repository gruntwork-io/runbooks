import { authEnvExport, type AZURE_AUTH_ENV_VARS, type EnvExport } from "../exec/authEnv.ts"
import type { AzurePrincipal } from "./claims.ts"

export type AzureAuthType = "cli" | "device_code" | "service_principal"

type AzureEnvVar = (typeof AZURE_AUTH_ENV_VARS)[number]

export const AZURE_SECRET_ENV_VARS = ["ARM_CLIENT_SECRET", "AZURE_CLIENT_SECRET"] as const

/**
 * An AzureAuth sign-in's variables, and the block's export of them, which
 * clears every other Azure variable for a script that names the block in
 * envFrom.
 */
export function azureEnv(input: {
  readonly authType: AzureAuthType
  readonly configDir: string
  readonly extensionDir?: string | undefined
  readonly principal: AzurePrincipal
  readonly tenantId: string
  readonly subscriptionId?: string | undefined
  readonly clientId?: string | undefined
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}): { set: Partial<Record<AzureEnvVar, string>>; envExport: EnvExport } {
  const set: Partial<Record<AzureEnvVar, string>> = {
    AZURE_CONFIG_DIR: input.configDir,
    AZURE_EXTENSION_DIR: input.extensionDir ?? `${input.configDir}/cliextensions`,
    AZURE_TENANT_ID: input.tenantId,
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
    set.ARM_TENANT_ID = input.tenantId
  } else {
    // No ARM_TENANT_ID: the azurerm backend passes it to `az account get-access-token`
    // as --tenant alongside --subscription, which Azure CLI refuses. The CLI's sign-in in
    // AZURE_CONFIG_DIR already has the tenant.
    set.ARM_USE_CLI = "true"
    if (input.certificatePath) set.AZURE_CLIENT_CERTIFICATE_PATH = input.certificatePath
  }
  const envExport = authEnvExport("azure", set as Record<string, string>)
  if (!envExport.ok) throw new Error(`azureEnv set a variable outside Azure's: ${envExport.error}`)
  return { set, envExport: envExport.export }
}
