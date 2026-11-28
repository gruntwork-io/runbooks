import { Button } from "@/components/ui/button"
import type { AzureSignInInfo } from "../types"
import { authTypeLabel, principalTypeLabel } from "../utils"

interface AuthSuccessProps {
  info: AzureSignInInfo
  onReAuthenticate: () => void
}

export function AuthSuccess({ info, onReAuthenticate }: AuthSuccessProps) {
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
      <div className="mt-3">
        <Button variant="outline" size="sm" onClick={onReAuthenticate}>
          Re-authenticate
        </Button>
      </div>
    </div>
  )
}
