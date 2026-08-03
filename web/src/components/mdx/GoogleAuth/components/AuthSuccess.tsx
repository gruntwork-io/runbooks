import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GoogleAccountInfo, GoogleCredentialType, GoogleDetectionSource } from "../types"
import { getSourceLabel } from "../utils"

interface AuthSuccessProps {
  accountInfo: GoogleAccountInfo
  /** Project-access warning from google:check-project, or a session-env warning. */
  warningMessage: string | null
  onReAuthenticate?: () => void
  /** Re-enter the project picker without discarding the credential. */
  onChangeProject?: () => void
  detectionSource?: GoogleDetectionSource
}

/**
 * Human label for a credentials-JSON `type`. Deliberately duplicated in
 * DetectedCredentialsPrompt rather than shared: the block's own tests mock every
 * `../components/*` module, so a helper imported across sibling components would
 * come back undefined under those mocks.
 */
function credentialTypeLabel(credentialType: GoogleCredentialType | undefined): string | null {
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
      return null
  }
}

export function AuthSuccess({
  accountInfo,
  warningMessage,
  onReAuthenticate,
  onChangeProject,
  detectionSource,
}: AuthSuccessProps) {
  const sourceLabel = detectionSource ? getSourceLabel(detectionSource) : null
  const typeLabel = credentialTypeLabel(accountInfo.credentialType)

  return (
    <div className="mb-4">
      <div className="text-success font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to Google Cloud</span>
        {sourceLabel && (
          <span className="text-xs bg-info-muted text-info px-2 py-0.5 rounded font-normal">
            {sourceLabel}
          </span>
        )}
      </div>
      <div className="bg-success-muted/50 rounded p-3 text-sm">
        <div className="text-foreground">
          <span className="font-medium">Project:</span> {accountInfo.projectId ?? 'Not set'}
          {accountInfo.projectName && (
            <span className="text-muted-foreground ml-1">({accountInfo.projectName})</span>
          )}
        </div>
        {accountInfo.principal && (
          <div className="text-muted-foreground text-xs mt-1 font-mono truncate" title={accountInfo.principal}>
            {accountInfo.principal}
          </div>
        )}
        {typeLabel && (
          <div className="text-muted-foreground text-xs mt-1">
            {typeLabel}
          </div>
        )}
        {/* The credentials file path is not a secret (0600, per-user temp dir) and
            is what downstream blocks receive as GOOGLE_APPLICATION_CREDENTIALS. */}
        {accountInfo.credentialsPath && (
          <div
            className="text-muted-foreground text-xs mt-1 font-mono truncate"
            title={accountInfo.credentialsPath}
          >
            GOOGLE_APPLICATION_CREDENTIALS={accountInfo.credentialsPath}
          </div>
        )}
      </div>
      {/* Warning about project access or the session env write */}
      {warningMessage && (
        <div className="mt-3 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div>{warningMessage}</div>
        </div>
      )}
      {/* Action buttons */}
      {(onChangeProject || onReAuthenticate) && (
        <div className="mt-3 flex gap-2">
          {onChangeProject && (
            <Button
              variant="outline"
              size="sm"
              onClick={onChangeProject}
            >
              Change Project
            </Button>
          )}
          {onReAuthenticate && (
            <Button
              variant="outline"
              size="sm"
              onClick={onReAuthenticate}
            >
              Re-authenticate
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
