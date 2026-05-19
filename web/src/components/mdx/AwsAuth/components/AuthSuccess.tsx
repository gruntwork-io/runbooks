import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AccountInfo, AwsDetectionSource } from "../types"
import { getSourceLabel } from "../utils"

interface AuthSuccessProps {
  accountInfo: AccountInfo
  warningMessage: string | null
  onReAuthenticate?: () => void
  detectionSource?: AwsDetectionSource
}

export function AuthSuccess({ accountInfo, warningMessage, onReAuthenticate, detectionSource }: AuthSuccessProps) {
  const sourceLabel = detectionSource ? getSourceLabel(detectionSource) : null
  
  return (
    <div className="mb-4">
      <div className="text-success font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to AWS</span>
        {sourceLabel && (
          <span className="text-xs bg-info-muted text-info px-2 py-0.5 rounded font-normal">
            {sourceLabel}
          </span>
        )}
      </div>
      <div className="bg-success-muted/50 rounded p-3 text-sm">
        <div className="text-foreground">
          <span className="font-medium">Account:</span> {accountInfo.accountId}
          {accountInfo.accountName && (
            <span className="text-muted-foreground ml-1">({accountInfo.accountName})</span>
          )}
        </div>
        {accountInfo.arn && (
          <div className="text-muted-foreground text-xs mt-1 font-mono truncate" title={accountInfo.arn}>
            {accountInfo.arn}
          </div>
        )}
      </div>
      {/* Warning about region opt-in status */}
      {warningMessage && (
        <div className="mt-3 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div>{warningMessage}</div>
        </div>
      )}
      {/* Action button */}
      {onReAuthenticate && (
        <div className="mt-3">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={onReAuthenticate}
          >
            Re-authenticate
          </Button>
        </div>
      )}
    </div>
  )
}
