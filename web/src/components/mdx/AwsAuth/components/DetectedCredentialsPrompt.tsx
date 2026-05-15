import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DetectedAwsCredentials } from "../types"
import { getSourceLabel } from "../utils"

interface DetectedCredentialsPromptProps {
  credentials: DetectedAwsCredentials
  warning?: string | null
  confirming?: boolean
  onConfirm: () => void
  onReject: () => void
}

export function DetectedCredentialsPrompt({
  credentials,
  warning,
  confirming = false,
  onConfirm,
  onReject,
}: DetectedCredentialsPromptProps) {
  return (
    <div className="mb-4">
      <div className="bg-info-muted border border-info/40 rounded-lg p-4">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <ShieldCheck className="size-5 text-info mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold text-foreground">
              AWS Credentials Detected
            </div>
            <div className="text-sm text-muted-foreground">
              Found credentials from {(getSourceLabel(credentials.source) ?? 'auto-detection').toLowerCase()}. 
              Please confirm you want to use this account.
            </div>
          </div>
        </div>

        {/* Account Info */}
        <div className="bg-card rounded border border-info/40 p-3 mb-3">
          <div className="grid gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground min-w-[80px]">Account:</span>
              <span className="font-mono font-semibold text-foreground">
                {credentials.accountId}
                {credentials.accountName && (
                  <span className="font-sans font-normal text-muted-foreground ml-2">
                    ({credentials.accountName})
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground min-w-[80px]">Identity:</span>
              <span className="font-mono text-xs text-foreground break-all" title={credentials.arn}>
                {credentials.arn}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground min-w-[80px]">Region:</span>
              <span className="font-mono text-foreground">
                {credentials.region}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground min-w-[80px]">Type:</span>
              <span className="text-foreground">
                {credentials.hasSessionToken ? 'Temporary credentials' : 'Static credentials'}
              </span>
            </div>
          </div>
          
          {/* Source badge */}
          <div className="mt-3 pt-3 border-t border-info/40">
            <span className="text-xs bg-info-muted text-info px-2 py-1 rounded">
              Source: {getSourceLabel(credentials.source) ?? 'Auto-detected'}
            </span>
          </div>
        </div>

        {/* Warning if any */}
        {warning && (
          <div className="bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2 mb-3">
            <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
            <div>{warning}</div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <Button
            onClick={onConfirm}
            disabled={confirming}
            size="sm"
            className="bg-info hover:bg-info/90 text-white"
          >
            {confirming && <Loader2 className="size-4 mr-2 animate-spin" />}
            {confirming ? 'Confirming…' : 'Use These Credentials'}
          </Button>
          <Button
            onClick={onReject}
            disabled={confirming}
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
