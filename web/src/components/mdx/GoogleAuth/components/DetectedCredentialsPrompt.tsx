import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DetectedGoogleCredentials, GoogleCredentialType } from "../types"
import { getSourceLabel } from "../utils"

interface DetectedCredentialsPromptProps {
  credentials: DetectedGoogleCredentials
  warning?: string | null
  confirming?: boolean
  onConfirm: () => void
  onReject: () => void
}

/**
 * Human label for a credentials-JSON `type`. Deliberately duplicated in
 * AuthSuccess rather than shared: the block's own tests mock every
 * `../components/*` module, so a helper imported across sibling components would
 * come back undefined under those mocks.
 */
function credentialTypeLabel(credentialType: GoogleCredentialType | undefined): string {
  switch (credentialType) {
    case 'service_account':
      return 'Service account key'
    case 'authorized_user':
      return 'User credentials (ADC)'
    case 'external_account':
      return 'Workload identity federation'
    case 'impersonated_service_account':
      return 'Impersonated service account'
    case 'access_token':
      return 'Access token'
    case 'gce_metadata':
      return 'Compute Engine metadata'
    default:
      return 'Unknown'
  }
}

/**
 * Confirm-before-use gate for auto-detected credentials. Detection is read-only
 * metadata; nothing reaches the session env and no outputs are registered until
 * the user says yes here — that is what makes an ambient
 * GOOGLE_APPLICATION_CREDENTIALS *this block's* credential.
 */
export function DetectedCredentialsPrompt({
  credentials,
  warning,
  confirming = false,
  onConfirm,
  onReject,
}: DetectedCredentialsPromptProps) {
  // Where it came from, precisely enough to spot the wrong project before use.
  const provenance = credentials.envVar
    ? `${credentials.envPrefix ?? ''}${credentials.envVar}`
    : credentials.configuration
      ? `gcloud configuration "${credentials.configuration}"`
      : credentials.path

  return (
    <div className="mb-4">
      <div className="bg-info-muted border border-info/40 rounded-lg p-4">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <ShieldCheck className="size-5 text-info mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold text-foreground">
              Google Cloud Credentials Detected
            </div>
            <div className="text-sm text-muted-foreground">
              Found credentials from {(getSourceLabel(credentials.source) ?? 'auto-detection').toLowerCase()}.
              Please confirm you want to use this project.
            </div>
          </div>
        </div>

        {/* Credential info */}
        <div className="bg-card rounded border border-info/40 p-3 mb-3">
          <div className="grid gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground min-w-[80px]">Project:</span>
              <span className="font-mono font-semibold text-foreground">
                {credentials.projectId}
                {credentials.projectName && (
                  <span className="font-sans font-normal text-muted-foreground ml-2">
                    ({credentials.projectName})
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground min-w-[80px]">Principal:</span>
              <span className="font-mono text-xs text-foreground break-all" title={credentials.principal}>
                {credentials.principal}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground min-w-[80px]">Type:</span>
              <span className="text-foreground">
                {credentialTypeLabel(credentials.credentialType)}
              </span>
            </div>
            {credentials.quotaProjectId && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground min-w-[80px]">Quota:</span>
                <span className="font-mono text-foreground">
                  {credentials.quotaProjectId}
                </span>
              </div>
            )}
            {provenance && (
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground min-w-[80px]">From:</span>
                <span className="font-mono text-xs text-foreground break-all" title={provenance}>
                  {provenance}
                </span>
              </div>
            )}
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
            className="bg-info hover:bg-info/90 text-info-foreground"
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
