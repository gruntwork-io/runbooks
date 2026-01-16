import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AccountInfo } from "../types"

interface AuthSuccessProps {
  accountInfo: AccountInfo
  warningMessage: string | null
  onReset: () => void
}

export function AuthSuccess({ accountInfo, warningMessage, onReset }: AuthSuccessProps) {
  return (
    <div className="mb-4">
      <div className="text-green-700 font-semibold text-sm mb-2">
        ✓ Authenticated to AWS
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
      <Button 
        variant="outline" 
        size="sm" 
        onClick={onReset}
        className="mt-3"
      >
        Re-authenticate
      </Button>
    </div>
  )
}
