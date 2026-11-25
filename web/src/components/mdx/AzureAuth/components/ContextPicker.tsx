import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AzurePrincipal, AzureSubscription, AzureTenant } from "../types"
import { principalTypeLabel } from "../utils"
import { DeviceCodePrompt } from "./DeviceCodePrompt"
import { INPUT_CLASSES } from "./TenantField"

interface ContextPickerProps {
  principal: AzurePrincipal | null
  tenants: AzureTenant[]
  subscriptions: AzureSubscription[]
  selectedTenantId: string
  onSelectTenant: (tenantId: string) => void
  selectedSubscriptionId: string
  onSelectSubscription: (subscriptionId: string) => void
  authenticating: boolean
  onContinue: () => void
  onCancel: () => void
  /** The chosen tenant wants a new sign-in, which is waiting. */
  tenantSignIn?: {
    deviceCodeFlow: boolean
    deviceCode: { verificationUri: string; userCode: string } | null
    onCancel: () => void
  } | null
}

const tenantLabel = (tenant: AzureTenant) =>
  tenant.displayName
    ? `${tenant.displayName}${tenant.defaultDomain ? ` (${tenant.defaultDomain})` : ""}`
    : tenant.tenantId

export function ContextPicker({
  principal,
  tenants,
  subscriptions,
  selectedTenantId,
  onSelectTenant,
  selectedSubscriptionId,
  onSelectSubscription,
  authenticating,
  onContinue,
  onCancel,
  tenantSignIn,
}: ContextPickerProps) {
  const inTenant = subscriptions.filter((sub) => sub.tenantId === selectedTenantId)
  return (
    <div className="space-y-4" data-testid="azure-context-picker">
      {principal && (
        <div className="text-sm text-muted-foreground">
          Signed in as <span className="font-mono text-foreground">{principal.name}</span> (
          {principalTypeLabel(principal.type)}). Choose where to work:
        </div>
      )}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Tenant</label>
        <select
          aria-label="Tenant"
          value={selectedTenantId}
          onChange={(e) => onSelectTenant(e.target.value)}
          className={INPUT_CLASSES}
          disabled={authenticating}
        >
          {tenants.map((tenant) => (
            <option key={tenant.tenantId} value={tenant.tenantId}>
              {tenantLabel(tenant)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Subscription</label>
        <select
          aria-label="Subscription"
          value={selectedSubscriptionId}
          onChange={(e) => onSelectSubscription(e.target.value)}
          className={INPUT_CLASSES}
          disabled={authenticating}
        >
          {inTenant.map((sub) => (
            <option key={sub.id} value={sub.id}>
              {sub.name} ({sub.id})
            </option>
          ))}
          <option value="">No subscription (tenant-level)</option>
        </select>
        {inTenant.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            This account has no subscriptions in this tenant. If you expected some, sign in to the
            tenant directly with its tenant ID.
          </p>
        )}
      </div>
      {tenantSignIn ? (
        <div className="space-y-3" role="status" data-testid="azure-tenant-sign-in">
          <p className="text-sm text-foreground">
            This tenant needs you to sign in again.{" "}
            {tenantSignIn.deviceCodeFlow
              ? "Open the sign-in page and enter the code shown here."
              : "Your browser will open."}
          </p>
          {tenantSignIn.deviceCode && <DeviceCodePrompt deviceCode={tenantSignIn.deviceCode} />}
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            {tenantSignIn.deviceCodeFlow && !tenantSignIn.deviceCode
              ? "Getting a device code..."
              : "Waiting for you to finish signing in..."}
          </div>
          <Button size="sm" variant="outline" onClick={tenantSignIn.onCancel}>
            Cancel sign-in
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={onContinue} disabled={authenticating || !selectedTenantId}>
            {authenticating && <Loader2 className="size-4 mr-2 animate-spin" />}
            Continue
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={authenticating}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
