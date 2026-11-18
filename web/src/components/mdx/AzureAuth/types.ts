import type {
  AzureAuthTypeIpc,
  AzurePrincipalIpc,
  AzureRequiredRoleIpc,
  AzureSubscriptionIpc,
  AzureTenantIpc,
} from "../../../../../electron/shared/channels.ts"

export type { AzurePrincipalIpc as AzurePrincipal }
export type { AzureTenantIpc as AzureTenant }
export type { AzureSubscriptionIpc as AzureSubscription }
export type { AzureRequiredRoleIpc as AzureRequiredRole }

export type AzureAuthMethod = "cli" | "device_code" | "service_principal"

export type AzureAuthStatus =
  | "pending"
  | "authenticating"
  | "authenticated"
  | "failed"
  | "select_context"

export type AzureDetectionStatus = "pending" | "detected" | "done"

export type AzureCredentialSource = "env" | { env: { prefix?: string } } | "cli"

export interface DetectedAzureCredentials {
  source: "env" | "cli"
  prefix?: string | undefined
  principalName: string
  tenantId?: string | undefined
  subscriptionId?: string | undefined
  subscriptionName?: string | undefined
  envVarPrefix?: string | undefined
}

export interface AzureSignInInfo {
  authType: AzureAuthTypeIpc
  principal: AzurePrincipalIpc
  tenantId: string
  tenantName?: string | undefined
  subscriptionId?: string | undefined
  subscriptionName?: string | undefined
}

export interface AzureAuthProps {
  id: string
  title?: string
  description?: string
  tenantId?: string
  subscriptionId?: string
  requiredRoles?: AzureRequiredRoleIpc[]
  detectCredentials?: false | AzureCredentialSource[]
  defaultTab?: AzureAuthMethod
  inputsId?: string | string[]
  autoCollapse?: boolean
}
