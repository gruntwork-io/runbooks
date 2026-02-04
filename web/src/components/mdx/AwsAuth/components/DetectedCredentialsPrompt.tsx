import { AlertTriangle, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DetectedAwsCredentials, AwsDetectionSource } from "../types"

interface DetectedCredentialsPromptProps {
  credentials: DetectedAwsCredentials
  warning?: string | null
  onConfirm: () => void
  onReject: () => void
}

function getSourceLabel(source: AwsDetectionSource): string {
  switch (source) {
    case 'env':
      return 'Environment Variables'
    case 'block':
      return 'Command Output'
    case 'default-profile':
      return 'Default AWS Profile'
    default:
      return 'Auto-detected'
  }
}

export function DetectedCredentialsPrompt({
  credentials,
  warning,
  onConfirm,
  onReject,
}: DetectedCredentialsPromptProps) {
  return (
    <div className="mb-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <ShieldCheck className="size-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold text-blue-900">
              AWS Credentials Detected
            </div>
            <div className="text-sm text-blue-700">
              Found credentials from {getSourceLabel(credentials.source).toLowerCase()}. 
              Please confirm you want to use this account.
            </div>
          </div>
        </div>

        {/* Account Info */}
        <div className="bg-white rounded border border-blue-200 p-3 mb-3">
          <div className="grid gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 min-w-[80px]">Account:</span>
              <span className="font-mono font-semibold text-gray-900">
                {credentials.accountId}
                {credentials.accountName && (
                  <span className="font-sans font-normal text-gray-600 ml-2">
                    ({credentials.accountName})
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-gray-500 min-w-[80px]">Identity:</span>
              <span className="font-mono text-xs text-gray-700 break-all" title={credentials.arn}>
                {credentials.arn}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 min-w-[80px]">Region:</span>
              <span className="font-mono text-gray-700">
                {credentials.region}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 min-w-[80px]">Type:</span>
              <span className="text-gray-700">
                {credentials.hasSessionToken ? 'Temporary credentials' : 'Static credentials'}
              </span>
            </div>
          </div>
          
          {/* Source badge */}
          <div className="mt-3 pt-3 border-t border-blue-100">
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
              Source: {getSourceLabel(credentials.source)}
            </span>
          </div>
        </div>

        {/* Warning if any */}
        {warning && (
          <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2 mb-3">
            <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
            <div>{warning}</div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <Button
            onClick={onConfirm}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Use These Credentials
          </Button>
          <Button
            onClick={onReject}
            variant="outline"
            size="sm"
          >
            Use Different Credentials
          </Button>
        </div>
      </div>
    </div>
  )
}
