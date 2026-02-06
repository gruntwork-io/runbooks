import { Loader2, ExternalLink, XCircle, Copy, Check, HelpCircle, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import type { GitHubAuthStatus } from "../types"

interface OAuthFlowProps {
  authStatus: GitHubAuthStatus
  effectiveClientId: string
  userCode: string | null
  verificationUri: string | null
  onStartOAuth: () => void
  onCancelOAuth: () => void
}

export function OAuthFlow({
  authStatus,
  effectiveClientId,
  userCode,
  verificationUri,
  onStartOAuth,
  onCancelOAuth,
}: OAuthFlowProps) {
  const [copied, setCopied] = useState(false)
  const [showPermissionsInfo, setShowPermissionsInfo] = useState(false)
  const [showAutoAuthInfo, setShowAutoAuthInfo] = useState(false)
  const isAuthenticating = authStatus === 'authenticating'
  const isWaitingForAuth = isAuthenticating && userCode && verificationUri

  const copyUserCode = async () => {
    if (userCode) {
      await navigator.clipboard.writeText(userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (!effectiveClientId) {
    return (
      <div className="text-red-700 text-sm flex items-start gap-2">
        <XCircle className="size-4 mt-0.5 flex-shrink-0" />
        <div>
          No OAuth client ID configured. Add <code className="bg-red-100 px-1 rounded">oauthClientId</code> prop or configure a default client ID.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-violet-100/50 rounded p-3 text-sm text-gray-700">
        {isWaitingForAuth ? (
          <>
            <p className="mb-2">
              <strong>Step 1:</strong> Copy this code:
            </p>
            <div className="flex items-center gap-2 mb-3">
              <code className="bg-white px-3 py-2 rounded border border-violet-200 text-lg font-mono font-bold tracking-wider">
                {userCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={copyUserCode}
                className="border-violet-300"
              >
                {copied ? (
                  <Check className="size-4 text-green-600" />
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
                className="border-violet-300 text-violet-700 hover:bg-violet-50"
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
            <p className="text-gray-500 text-xs">
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
          className="bg-violet-600 hover:bg-violet-700 text-white"
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
            className="border-gray-300 text-gray-700 hover:bg-gray-100"
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
            className="flex items-center gap-1 text-gray-500 hover:text-gray-700 cursor-pointer"
          >
            <HelpCircle className="size-3" />
            <span>What permissions does this grant?</span>
            {showPermissionsInfo ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          
          {showPermissionsInfo && (
            <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 text-gray-600 space-y-2">
              <p>
                OAuth authentication works without any separate Gruntwork infrastructure. However, GitHub's OAuth 
                permissions are coarse-grained, and the smallest scope that grants private repository access 
                is <code className="bg-gray-200 px-1 rounded text-xs">repo</code>, which grants "full control of private repositories."
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

        {/* Auto-auth info */}
        <div>
          <button
            type="button"
            onClick={() => setShowAutoAuthInfo(!showAutoAuthInfo)}
            className="flex items-center gap-1 text-gray-500 hover:text-gray-700 cursor-pointer"
          >
            <HelpCircle className="size-3" />
            <span>How can I authenticate to GitHub automatically?</span>
            {showAutoAuthInfo ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          
          {showAutoAuthInfo && (
            <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 text-gray-600 space-y-2">
              <p>
                Runbooks can automatically detect your GitHub credentials so you don't have to sign in manually each time.
              </p>
              <p>
                <strong>Option 1: GitHub CLI</strong> — Run <code className="bg-gray-200 px-1 rounded text-xs">gh auth login</code> in 
                your terminal.
              </p>
              <p>
                <strong>Option 2: Environment variable</strong> — Set <code className="bg-gray-200 px-1 rounded text-xs">GITHUB_TOKEN</code> to 
                your GitHub Personal Access Token.
              </p>
              <p className="text-gray-500">
                After setting up either option, reload the runbook and Runbooks will detect your credentials automatically.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
