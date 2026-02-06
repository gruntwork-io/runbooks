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
      <div className="text-green-700 font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to AWS</span>
        {sourceLabel && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-normal">
            {sourceLabel}
          </span>
        )}
      </div>
      <div className="bg-green-100/50 rounded p-3 text-sm">
        <div className="text-gray-700">
          <span className="font-medium">Account:</span> {accountInfo.accountId}
          {accountInfo.accountName && (
            <span className="text-gray-600 ml-1">({accountInfo.accountName})</span>
          )}
        </div>
        {accountInfo.arn && (
          <div className="text-gray-600 text-xs mt-1 font-mono truncate" title={accountInfo.arn}>
            {accountInfo.arn}
          </div>
        )}
      </div>
      {/* Warning about region opt-in status */}
      {warningMessage && (
        <div className="mt-3 bg-amber-100 border border-amber-300 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
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
