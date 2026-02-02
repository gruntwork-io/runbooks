import { useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GitHubUserInfo, GitHubDetectionSource, GitHubTokenType } from "../types"

interface AuthSuccessProps {
  userInfo: GitHubUserInfo
  detectionSource?: GitHubDetectionSource
  detectedScopes?: string[] | null
  detectedTokenType?: GitHubTokenType | null
  scopeWarning?: string | null
  onReAuthenticate?: () => void
}

// Helper to get user-friendly token type label
function getTokenTypeLabel(tokenType: GitHubTokenType): string {
  switch (tokenType) {
    case 'fine_grained_pat':
      return 'Fine-grained PAT'
    case 'classic_pat':
      return 'Classic PAT'
    case 'oauth':
      return 'OAuth Token'
    case 'github_app':
      return 'GitHub App Token'
    default:
      return 'Token'
  }
}

// GitHub scopes documentation URL
const GITHUB_SCOPES_DOCS_URL = 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes'

// Brief descriptions for common GitHub scopes
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'repo': 'Full access to repositories',
  'repo:status': 'Access commit statuses',
  'repo_deployment': 'Access deployment statuses',
  'public_repo': 'Access public repositories only',
  'repo:invite': 'Accept/decline repo invitations',
  'security_events': 'Read/write security events',
  'admin:repo_hook': 'Full control of repository hooks',
  'write:repo_hook': 'Write repository hooks',
  'read:repo_hook': 'Read repository hooks',
  'admin:org': 'Full control of orgs and teams',
  'write:org': 'Read/write org membership',
  'read:org': 'Read org membership',
  'admin:public_key': 'Full control of public keys',
  'write:public_key': 'Write public keys',
  'read:public_key': 'Read public keys',
  'admin:org_hook': 'Full control of organization hooks',
  'gist': 'Create gists',
  'notifications': 'Access notifications',
  'user': 'Read/write user profile',
  'read:user': 'Read user profile',
  'user:email': 'Access user email',
  'user:follow': 'Follow/unfollow users',
  'project': 'Read/write projects',
  'read:project': 'Read projects',
  'delete_repo': 'Delete repositories',
  'write:packages': 'Upload packages',
  'read:packages': 'Download packages',
  'delete:packages': 'Delete packages',
  'admin:gpg_key': 'Full control of GPG keys',
  'write:gpg_key': 'Write GPG keys',
  'read:gpg_key': 'Read GPG keys',
  'codespace': 'Full control of codespaces',
  'workflow': 'Update GitHub Actions workflows',
}

export function AuthSuccess({ 
  userInfo, 
  detectionSource, 
  detectedScopes,
  detectedTokenType,
  scopeWarning,
  onReAuthenticate,
}: AuthSuccessProps) {
  const [showPermissions, setShowPermissions] = useState(false)
  const isFineGrainedPat = detectedTokenType === 'fine_grained_pat'
  
  return (
    <div className="mb-4">
      <div className="text-green-700 font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to GitHub</span>
        {detectionSource && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-normal">
            {detectionSource === 'env' && 'From Environment'}
            {detectionSource === 'cli' && 'Via GitHub CLI'}
            {detectionSource === 'block' && 'From Command'}
          </span>
        )}
      </div>
      <div className="bg-green-100/50 rounded p-3 text-sm">
        <div className="flex items-center gap-3">
          {userInfo.avatarUrl && (
            <img 
              src={userInfo.avatarUrl} 
              alt={userInfo.login}
              className="w-10 h-10 rounded-full border border-green-200"
            />
          )}
          <div>
            <div className="text-gray-700 font-medium">
              {userInfo.name || userInfo.login}
            </div>
            <div className="text-gray-500 text-xs">
              @{userInfo.login}
              {userInfo.email && ` • ${userInfo.email}`}
            </div>
            {/* Show token type */}
            {detectedTokenType && (
              <div className="text-gray-400 text-xs mt-1 flex items-center gap-1">
                {isFineGrainedPat && <Shield className="size-3" />}
                <span>{getTokenTypeLabel(detectedTokenType)}</span>
              </div>
            )}
          </div>
        </div>
        
        {/* Show scopes as a collapsible section */}
        {detectedScopes && detectedScopes.length > 0 && (
          <div className="mt-3 pt-3 border-t border-green-200">
            <button
              onClick={() => setShowPermissions(!showPermissions)}
              className="flex items-center gap-1 text-xs text-gray-500 font-medium hover:text-gray-700 transition-colors cursor-pointer"
            >
              {showPermissions ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Token Permissions ({detectedScopes.length})
            </button>
            {showPermissions && (
              <div className="mt-2">
                <div className="flex flex-wrap gap-1.5">
                  {detectedScopes.map((scope) => (
                    <span
                      key={scope}
                      className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs"
                      title={SCOPE_DESCRIPTIONS[scope] || scope}
                    >
                      <code className="text-[10px] font-mono">{scope}</code>
                      {SCOPE_DESCRIPTIONS[scope] && (
                        <span className="text-gray-400">— {SCOPE_DESCRIPTIONS[scope]}</span>
                      )}
                    </span>
                  ))}
                </div>
                <a
                  href={GITHUB_SCOPES_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 hover:underline mt-2"
                >
                  Learn more about these permissions
                  <ExternalLink className="size-3" />
                </a>
              </div>
            )}
          </div>
        )}
        
        {/* Note for fine-grained PATs */}
        {isFineGrainedPat && !detectedScopes?.length && (
          <div className="mt-3 pt-3 border-t border-green-200 text-gray-500 text-xs">
            Fine-grained PATs use repository-specific permissions.{' '}
            <a 
              href="https://github.com/settings/personal-access-tokens" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
            >
              View all your tokens
              <ExternalLink className="size-3" />
            </a>
            {' '}to find this token's permissions.
          </div>
        )}
        {scopeWarning && (
          <div className="mt-3 pt-3 border-t border-green-200 flex items-start gap-2 text-amber-700 text-xs">
            <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Missing "repo" scope</strong>
              <br />
              Operations on private repos, issues, and PRs may fail.
            </div>
          </div>
        )}
      </div>
      {/* Action button */}
      {onReAuthenticate && (
        <div className="mt-3">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={onReAuthenticate}
          >
            {scopeWarning ? 'Re-authenticate with full permissions' : 'Re-authenticate'}
          </Button>
        </div>
      )}
    </div>
  )
}
