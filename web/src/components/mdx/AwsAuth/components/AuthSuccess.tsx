import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AccountInfo, PrefilledCredentialsType } from "../types"

interface AuthSuccessProps {
  accountInfo: AccountInfo
  warningMessage: string | null
  onRetryPrefill?: () => void
  onManualAuth?: () => void
  prefillSource?: PrefilledCredentialsType | null
}

export function AuthSuccess({ accountInfo, warningMessage, onRetryPrefill, onManualAuth, prefillSource }: AuthSuccessProps) {
  return (
    <div className="mb-4">
      <div className="text-green-700 font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to AWS</span>
        {prefillSource && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-normal">
            {prefillSource === 'env' && 'From Environment'}
            {prefillSource === 'block' && 'From Command Output'}
            {prefillSource === 'static' && 'Pre-configured'}
          </span>
        )}
      </div>
      <div className="bg-green-100/50 rounded p-3 text-sm">
        <div className="text-gray-700">
          <span className="font-medium">Account:</span> {accountInfo.accountId}
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
      {/* Action buttons */}
      {(onRetryPrefill || onManualAuth) && (
        <div className="mt-3 flex items-center gap-3">
          {onRetryPrefill && (
            <Button 
              variant="outline" 
              size="sm" 
              onClick={onRetryPrefill}
            >
              Re-authenticate
            </Button>
          )}
          {onManualAuth && (
            <Button 
              variant="link" 
              size="sm" 
              onClick={onManualAuth}
            >
              Authenticate manually
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
