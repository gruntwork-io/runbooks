import { AlertTriangle, Loader2, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DetectedGoogleCredentials } from "../types"
import { getSourceLabel } from "../utils"
import { MissingScopesDetails, ScopesCommand } from "./MissingScopes"

interface InsufficientScopesPromptProps {
  credentials: DetectedGoogleCredentials
  requiredScopes: string[]
  oauthUnavailable: boolean
  recovering?: boolean
  onSignIn: () => void
  onReject: () => void
  onRetryDetection: () => void
}

/**
 * Detected credential that validated but lacks the author's required OAuth
 * scopes. Refuses "Use These Credentials" and offers Sign-In recovery (or the
 * equivalent gcloud --scopes command when Sign-In is unavailable).
 */
export function InsufficientScopesPrompt({
  credentials,
  requiredScopes,
  oauthUnavailable,
  recovering = false,
  onSignIn,
  onReject,
  onRetryDetection,
}: InsufficientScopesPromptProps) {
  const missing = credentials.missingScopes ?? []

  return (
    <div className="mb-4">
      <div className="bg-warning-muted border border-warning/40 rounded-lg p-4">
        <div className="flex items-start gap-3 mb-3">
          <AlertTriangle className="size-5 text-warning mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold text-foreground">Credentials missing required scopes</div>
            <div className="text-sm text-muted-foreground">
              Found credentials from{" "}
              {(getSourceLabel(credentials.source) ?? "auto-detection").toLowerCase()}, but they do
              not include every scope this runbook needs.
            </div>
          </div>
        </div>

        <div className="bg-card rounded border border-warning/40 p-3 mb-3 text-sm space-y-2">
          {credentials.principal && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground min-w-[80px]">Principal:</span>
              <span className="font-mono text-xs text-foreground break-all">
                {credentials.principal}
              </span>
            </div>
          )}
          <MissingScopesDetails missing={missing} />
        </div>

        {!oauthUnavailable ? (
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              onClick={onSignIn}
              disabled={recovering}
              size="sm"
              className="bg-info hover:bg-info/90 text-info-foreground"
            >
              {recovering ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <LogIn className="size-4 mr-2" />
              )}
              {recovering ? "Starting sign-in…" : "Sign in with required scopes"}
            </Button>
            <Button onClick={onReject} disabled={recovering} variant="outline" size="sm">
              Use Different Credentials
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Google Sign-In needs an OAuth client: start Runbooks with{" "}
              <code>GOOGLE_OAUTH_CLIENT_CREDENTIALS</code> set to your OAuth client's JSON file, or
              authenticate manually with credentials that already carry these scopes.
            </p>
            <ScopesCommand requiredScopes={requiredScopes} />
            <div className="flex items-center gap-3 flex-wrap">
              <Button onClick={onRetryDetection} disabled={recovering} size="sm">
                Check again
              </Button>
              <Button onClick={onReject} disabled={recovering} variant="outline" size="sm">
                Use Different Credentials
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
