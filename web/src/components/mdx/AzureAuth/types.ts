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

/** Which sign-in tab is active. */
export type AzureAuthMethod = "cli" | "device_code" | "service_principal"

export type AzureAuthStatus =
  | "pending"
  | "authenticating"
  | "authenticated"
  | "failed"
  | "select_context"

export type AzureDetectionStatus = "pending" | "detected" | "done"

/**
 * Where to look for an existing sign-in, tried in the order written:
 * - `"env"`: a service principal in ARM_* or AZURE_* (client ID, tenant ID, and
 *   a secret or certificate path);
 * - `{ env: { prefix } }`: the same names with a prefix, e.g. `CI_ARM_CLIENT_ID`;
 * - `"cli"`: the Azure CLI's own sign-in (`az login`).
 */
export type AzureCredentialSource = "env" | { env: { prefix?: string } } | "cli"

/** An existing sign-in detection found, awaiting the user's confirmation. */
export interface DetectedAzureCredentials {
  source: "env" | "cli"
  prefix?: string | undefined
  principalName: string
  tenantId?: string | undefined
  subscriptionId?: string | undefined
  subscriptionName?: string | undefined
  envVarPrefix?: string | undefined
}

/** What the success card shows. */
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
  /** Pin a tenant: the picker is skipped, and interactive sign-in goes straight to it. */
  tenantId?: string
  /** Pin a subscription (ID or name): the picker is skipped. */
  subscriptionId?: string
  /** Roles the signed-in principal must hold, e.g. `[{ role: "Owner", scope: "subscription" }]`. */
  requiredRoles?: AzureRequiredRoleIpc[]
  /** `false`, or the sources to try in order. Defaults to `["env", "cli"]`. */
  detectCredentials?: false | AzureCredentialSource[]
  /** The tab to open on: `cli`, `device_code` or `service_principal`. */
  defaultTab?: AzureAuthMethod
  inputsId?: string | string[]
  autoCollapse?: boolean
}
