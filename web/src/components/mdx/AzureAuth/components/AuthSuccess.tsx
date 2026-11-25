import { AlertTriangle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AzureSignInInfo } from "../types"
import { authTypeLabel, principalTypeLabel } from "../utils"

interface AuthSuccessProps {
  info: AzureSignInInfo
  warningMessage: string | null
  errorMessage?: string | null
  onReAuthenticate: () => void
  /** Offered for a user sign-in the block may move to another tenant. */
  onChangeTenant?: (() => void) | undefined
  loadingTenants?: boolean
}

export function AuthSuccess({
  info,
  warningMessage,
  errorMessage,
  onReAuthenticate,
  onChangeTenant,
  loadingTenants = false,
}: AuthSuccessProps) {
  const { principal } = info
  return (
    <div className="mb-4">
      <div className="text-success font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Signed in to Azure</span>
        <span className="text-xs bg-info-muted text-info px-2 py-0.5 rounded font-normal">
          {authTypeLabel(info.authType)}
        </span>
      </div>
      <div className="bg-success-muted/50 rounded p-3 text-sm grid gap-1">
        <div className="text-foreground">
          <span className="font-medium">{principalTypeLabel(principal.type)}:</span>{" "}
          <span className="font-mono">{principal.name}</span>
        </div>
        <div className="text-foreground">
          <span className="font-medium">Tenant:</span> {info.tenantName ?? info.tenantId}
          {info.tenantName && (
            <span className="text-muted-foreground ml-1 font-mono text-xs">({info.tenantId})</span>
          )}
        </div>
        <div className="text-foreground">
          <span className="font-medium">Subscription:</span>{" "}
          {info.subscriptionId ? (
            <>
              {info.subscriptionName ?? info.subscriptionId}
              {info.subscriptionName && (
                <span className="text-muted-foreground ml-1 font-mono text-xs">
                  ({info.subscriptionId})
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">none (tenant-level)</span>
          )}
        </div>
        {principal.type === "guest" && principal.homeTenantId && (
          <div className="text-muted-foreground text-xs">
            Guest from tenant <span className="font-mono">{principal.homeTenantId}</span>
          </div>
        )}
      </div>
      {warningMessage && (
        <div className="mt-3 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">{warningMessage}</div>
        </div>
      )}
      {errorMessage && (
        <div className="mt-3 text-destructive text-sm flex items-start gap-2" role="alert">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">{errorMessage}</div>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" onClick={onReAuthenticate} disabled={loadingTenants}>
          Re-authenticate
        </Button>
        {onChangeTenant && (
          <Button variant="outline" size="sm" onClick={onChangeTenant} disabled={loadingTenants}>
            {loadingTenants && <Loader2 className="size-4 mr-2 animate-spin" />}
            Change tenant
          </Button>
        )}
      </div>
    </div>
  )
}
