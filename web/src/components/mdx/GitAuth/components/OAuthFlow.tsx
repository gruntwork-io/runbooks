import { Loader2, ExternalLink, XCircle, Copy, Check, HelpCircle, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import type { GitAuthStatus } from "../types"
import type { ProviderConfig } from "../providers"
import { AutoAuthInfo } from "./AutoAuthInfo"

interface OAuthFlowProps {
  authStatus: GitAuthStatus
  effectiveClientId: string
  userCode: string | null
  verificationUri: string | null
  onStartOAuth: () => void
  onCancelOAuth: () => void
  provider: ProviderConfig
}

export function OAuthFlow({
  authStatus,
  effectiveClientId,
  userCode,
  verificationUri,
  onStartOAuth,
  onCancelOAuth,
  provider,
}: OAuthFlowProps) {
  const { didCopy: copied, copy: doCopy } = useCopyToClipboard(2000)
  const [showPermissionsInfo, setShowPermissionsInfo] = useState(false)
  const isAuthenticating = authStatus === 'authenticating'
  const isWaitingForAuth = isAuthenticating && userCode && verificationUri

  const copyUserCode = () => {
    if (userCode) void doCopy(userCode)
  }

  if (!effectiveClientId) {
    return (
      <div className="text-destructive text-sm flex items-start gap-2">
        <XCircle className="size-4 mt-0.5 flex-shrink-0" />
        <div>
          No OAuth client ID configured. Add <code className="bg-destructive-muted px-1 rounded">oauthClientId</code> prop or configure a default client ID.
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
              <strong>Step 1:</strong> Copy this code:
            </p>
            <div className="flex items-center gap-2 mb-3">
              <code className="bg-card px-3 py-2 rounded border border-info/40 text-lg font-mono font-bold tracking-wider">
                {userCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={copyUserCode}
                className="border-border"
              >
                {copied ? (
                  <Check className="size-4 text-success" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <p className="mb-2">
              <strong>Step 2:</strong> Open GitHub and enter the code:
            </p>
            <div className="mb-3">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="border-border text-info hover:bg-info-muted"
              >
                <a
                  href={verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open GitHub
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              We check for authorization every 5 seconds. If you cancelled on GitHub, click Cancel below.
            </p>
          </>
        ) : (
          <p>
            Click the button below to sign in with GitHub. You'll be redirected to authorize this app.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          onClick={onStartOAuth}
          disabled={isAuthenticating}
          className="bg-info hover:bg-info/90 text-info-foreground"
        >
          {isAuthenticating ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Waiting for authorization...
            </>
          ) : (
            <>
              <ExternalLink className="size-4" />
              Sign in with GitHub
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

      {/* FAQ section */}
      <div className="text-xs space-y-2">
        {/* Permissions info */}
        <div>
          <button
            type="button"
            onClick={() => setShowPermissionsInfo(!showPermissionsInfo)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <HelpCircle className="size-3" />
            <span>What permissions does this grant?</span>
            {showPermissionsInfo ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          
          {showPermissionsInfo && (
            <div className="mt-2 p-3 bg-muted rounded border border-border text-muted-foreground space-y-2">
              <p>
                OAuth authentication works without any separate Gruntwork infrastructure. However, GitHub's OAuth 
                permissions are coarse-grained, and the smallest scope that grants private repository access 
                is <code className="bg-accent px-1 rounded text-xs">repo</code>, which grants "full control of private repositories."
              </p>
              <p>
                <strong>Your token stays local.</strong> Gruntwork never sees your token and will not have any access to your GitHub resources.
              </p>
              <p>
                If you prefer finer-grained permissions, use a <strong>Personal Access Token</strong> instead (see the other tab). 
                In the future, we may set up a GitHub App, which would allow more granular permissions with OAuth.
              </p>
            </div>
          )}
        </div>

        {/* Auto-auth info (shared with the GitLab PAT flow) */}
        <AutoAuthInfo provider={provider} />
      </div>
    </div>
  )
}
