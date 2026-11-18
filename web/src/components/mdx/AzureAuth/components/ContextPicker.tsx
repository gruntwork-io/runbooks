import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AzurePrincipal, AzureSubscription, AzureTenant } from "../types"
import { principalTypeLabel } from "../utils"
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
}

const tenantLabel = (tenant: AzureTenant) =>
  tenant.displayName
    ? `${tenant.displayName}${tenant.defaultDomain ? ` (${tenant.defaultDomain})` : ""}`
    : tenant.tenantId

/** Pick a tenant, then a subscription in it (or none, for tenant-level work). */
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
      <div className="flex gap-2">
        <Button size="sm" onClick={onContinue} disabled={authenticating || !selectedTenantId}>
          {authenticating && <Loader2 className="size-4 mr-2 animate-spin" />}
          Continue
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={authenticating}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
