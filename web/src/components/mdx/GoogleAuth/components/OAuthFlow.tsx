import { useState } from "react"
import {
  Loader2,
  XCircle,
  AlertTriangle,
  Copy,
  Check,
  HelpCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { GoogleCloudMark } from "./GoogleCloudLogo"
import { RegionPicker } from "./RegionPicker"
import { DEFAULT_GOOGLE_SCOPES } from "../constants"
import type { GoogleAuthStatus } from "../types"

interface OAuthFlowProps {
  authStatus: GoogleAuthStatus
  /** Non-null while a loopback flow is live (hook: `oauthFlowId`). */
  flowId: string | null
  /** Google's consent-screen URL for the live flow (hook: `oauthAuthUrl`). */
  authUrl: string | null
  /**
   * True when neither the build default nor an author prop supplies an OAuth
   * client id (hook: `oauthUnavailable`).
   */
  oauthUnavailable: boolean
  /** Scopes the author asked for; falls back to the build defaults. */
  scopes?: string[]
  selectedRegion: string
  setSelectedRegion: (value: string) => void
  /** hook: `handleOAuthLogin` */
  onStartOAuth: () => void
  /** hook: `handleCancelOAuth` */
  onCancelOAuth: () => void
}

/**
 * Google Sign-In tab — the SsoFlow analogue. The transport is a loopback
 * redirect (RFC 8252) rather than a device code, so there is no user code to
 * type: the browser opens on Google's consent screen and returns to a local
 * 127.0.0.1 callback. The URL is offered as copyable text (not a link) because
 * the browser handoff is main's job — components never touch IPC.
 */
export function OAuthFlow({
  authStatus,
  flowId,
  authUrl,
  oauthUnavailable,
  scopes,
  selectedRegion,
  setSelectedRegion,
  onStartOAuth,
  onCancelOAuth,
}: OAuthFlowProps) {
  const { didCopy: copied, copy: doCopy } = useCopyToClipboard(2000)
  const [showScopeInfo, setShowScopeInfo] = useState(false)
  const isAuthenticating = authStatus === 'authenticating'
  const isWaitingForAuth = isAuthenticating && Boolean(flowId) && Boolean(authUrl)
  const requestedScopes = scopes && scopes.length > 0 ? scopes : [...DEFAULT_GOOGLE_SCOPES]

  const copyAuthUrl = () => {
    if (authUrl) void doCopy(authUrl)
  }

  if (oauthUnavailable) {
    return (
      <div className="text-warning text-sm flex items-start gap-2">
        <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
        <div>
          OAuth login is not configured for this build. Use the{' '}
          <strong>Service Account Key</strong> or <strong>gcloud Config</strong> tab instead.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-info-muted/50 rounded p-3 text-sm text-foreground">
        {isWaitingForAuth ? (
          <>
            <p className="mb-2">
              Finish signing in on the Google consent screen in your browser. This page updates
              automatically once you approve.
            </p>
            <div className="flex items-center gap-2 mb-2">
              <code className="bg-card px-3 py-2 rounded border border-info/40 text-xs font-mono truncate flex-1" title={authUrl ?? undefined}>
                {authUrl}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={copyAuthUrl}
                aria-label="Copy sign-in URL"
                className="border-border"
              >
                {copied ? (
                  <Check className="size-4 text-success" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <span className="text-muted-foreground text-xs block">
              Didn't get a browser tab? Copy the URL above and open it manually. If you cancelled on
              Google, click Cancel below — Google doesn't notify this page when you cancel.
            </span>
          </>
        ) : (
          <p>
            Click the button below to sign in with Google. A browser tab opens on Google's consent
            screen and returns here through a local callback on{' '}
            <code className="bg-card px-1 rounded">127.0.0.1</code>. Runbooks stores the resulting
            credentials in a private file and points{' '}
            <code className="bg-card px-1 rounded">GOOGLE_APPLICATION_CREDENTIALS</code> at it.
          </p>
        )}
      </div>

      <RegionPicker
        selectedRegion={selectedRegion}
        setSelectedRegion={setSelectedRegion}
        disabled={isAuthenticating}
      />

      <div className="flex gap-2">
        <Button
          onClick={onStartOAuth}
          disabled={isAuthenticating}
          className="bg-info hover:bg-info/90 text-info-foreground"
        >
          {isAuthenticating ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Waiting for browser sign-in...
            </>
          ) : (
            <>
              <GoogleCloudMark className="size-4" />
              Sign in with Google
            </>
          )}
        </Button>

        {isAuthenticating && (
          <Button
            onClick={onCancelOAuth}
            variant="outline"
            className="border-input text-foreground hover:bg-accent"
          >
            <XCircle className="size-4" />
            Cancel
          </Button>
        )}
      </div>

      {/* Scope disclosure */}
      <div className="text-xs">
        <button
          type="button"
          onClick={() => setShowScopeInfo(!showScopeInfo)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <HelpCircle className="size-3" />
          <span>What permissions does this grant?</span>
          {showScopeInfo ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>

        {showScopeInfo && (
          <div className="mt-2 p-3 bg-muted rounded border border-border text-muted-foreground space-y-2">
            <p>Runbooks requests these OAuth scopes:</p>
            <ul className="ml-4 list-disc space-y-0.5">
              {requestedScopes.map((scope) => (
                <li key={scope}>
                  <code className="bg-accent px-1 rounded break-all">{scope}</code>
                </li>
              ))}
            </ul>
            <p>
              <strong>Your credentials stay local.</strong> The sign-in completes on your machine and
              the resulting credentials are written to a private file that only this app and the
              commands it runs can read.
            </p>
            <p>
              Scopes are coarse-grained:{' '}
              <code className="bg-accent px-1 rounded">cloud-platform</code> grants the same access
              your Google account already has. For narrower access, use a{' '}
              <strong>Service Account Key</strong> with only the roles you need.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
