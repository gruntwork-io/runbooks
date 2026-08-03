import { AlertTriangle, Copy, Loader2, LogIn } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatGcloudAdcLoginCommand } from '../constants'
import type { DetectedGoogleCredentials } from '../types'
import { getSourceLabel } from '../utils'

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
  const [copied, setCopied] = useState(false)
  const missing = credentials.missingScopes ?? []
  const command = formatGcloudAdcLoginCommand(requiredScopes)

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be denied; the command is still selectable in the UI.
    }
  }

  return (
    <div className="mb-4">
      <div className="bg-warning-muted border border-warning/40 rounded-lg p-4">
        <div className="flex items-start gap-3 mb-3">
          <AlertTriangle className="size-5 text-warning mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold text-foreground">
              Credentials missing required scopes
            </div>
            <div className="text-sm text-muted-foreground">
              Found credentials from {(getSourceLabel(credentials.source) ?? 'auto-detection').toLowerCase()},
              but they do not include every scope this runbook needs.
            </div>
          </div>
        </div>

        <div className="bg-card rounded border border-warning/40 p-3 mb-3 text-sm space-y-2">
          {credentials.principal && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground min-w-[80px]">Principal:</span>
              <span className="font-mono text-xs text-foreground break-all">{credentials.principal}</span>
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
              {recovering ? 'Starting sign-in…' : 'Sign in with required scopes'}
            </Button>
            <Button onClick={onReject} disabled={recovering} variant="outline" size="sm">
              Use Different Credentials
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Google Sign-In is unavailable in this build. Run the command below as the same
              principal, then try auto-detection again — or authenticate manually with a credential
              that already carries these scopes.
            </p>
            <div className="flex items-start gap-2">
              <code className="flex-1 bg-card border border-warning/30 rounded px-2 py-1.5 text-xs font-mono break-all">
                {command}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyCommand()}>
                <Copy className="size-3.5 mr-1" />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <Button onClick={onRetryDetection} disabled={recovering} size="sm">
                Try auto-detection again
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
