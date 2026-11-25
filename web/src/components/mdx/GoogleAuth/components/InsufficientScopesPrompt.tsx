import { AlertTriangle, Copy, Loader2, LogIn } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { formatGcloudAdcLoginCommand } from "../../../../../../src/domain/google/scopes"
import type { DetectedGoogleCredentials } from "../types"
import { getSourceLabel } from "../utils"

interface InsufficientScopesPromptProps {
  credentials: DetectedGoogleCredentials
  requiredScopes: string[]
  oauthUnavailable: boolean
  recovering?: boolean
  onSignIn: () => void
  onChooseOAuthClient: () => void
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
  onChooseOAuthClient,
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
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground min-w-[80px]">Missing:</span>
            <ul className="list-disc ml-4 space-y-0.5">
              {missing.map((scope) => (
                <li key={scope}>
                  <code className="bg-accent px-1 rounded break-all text-xs">{scope}</code>
                </li>
              ))}
            </ul>
          </div>
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
            <ChooseOAuthClient onChoose={onChooseOAuthClient} disabled={recovering} />
            <GcloudLoginCommand command={formatGcloudAdcLoginCommand(requiredScopes)} />
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

function ChooseOAuthClient({ onChoose, disabled }: { onChoose: () => void; disabled: boolean }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Google Sign-In can request these scopes, but it does not have an OAuth client yet. Choose
        your Desktop OAuth client JSON file to sign in.
      </p>
      <Button onClick={onChoose} disabled={disabled} size="sm">
        Choose Desktop OAuth client JSON
      </Button>
    </div>
  )
}

function GcloudLoginCommand({ command }: { command: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        If Google grants these scopes to gcloud's own OAuth client, you can instead run this command
        and click <strong>Check again</strong>. Google shows "This app is blocked" when it does not.
      </p>
      <div className="flex items-start gap-2">
        <code className="flex-1 bg-card border border-warning/30 rounded px-2 py-1.5 text-xs font-mono break-all">
          {command}
        </code>
        <CopyButton text={command} />
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be denied; the command is still selectable in the UI.
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copyText()}>
      <Copy className="size-3.5 mr-1" />
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}
