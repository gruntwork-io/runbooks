import { useState } from "react"
import { AlertTriangle, Bot, ChevronDown, ChevronRight, ExternalLink, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GitUserInfo, GitDetectionSource, GitSuccessMeta, GitTokenType } from "../types"
import type { ProviderConfig } from "../providers"

interface AuthSuccessProps {
  userInfo: GitUserInfo
  provider: ProviderConfig
  detectionSource?: GitDetectionSource
  detectedScopes?: string[] | null
  detectedTokenType?: GitTokenType | null
  scopeWarning?: string | null
  sessionEnvWarning?: string | null
  /** The host authenticated against (GitLab); shown so multi-host users see which instance. */
  host?: string
  /** Provenance for the source line + transport line. */
  successMeta?: GitSuccessMeta | null
  /** both-set-and-differ env hint, rendered verbatim. */
  divergenceHint?: string | null
  /** another block replaced this provider's session credential. */
  sessionStale?: boolean
  /** Windows git TLS backend (vcs:cli-status; win32 only) — drives the schannel suggestion. */
  gitSslBackend?: string
  /** Explicit, consented one-click `git config --global http.sslBackend schannel`. */
  onApplySchannel?: () => void
  onReAuthenticate?: () => void
}

/** Initials for the avatar fallback: first letters of up to two name words
 *  (falling back to the login). */
function initialsFor(userInfo: GitUserInfo): string {
  const source = (userInfo.name?.trim() || userInfo.login).trim()
  const parts = source.split(/\s+/).filter(Boolean)
  const initials = `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase()
  return initials || source.slice(0, 1).toUpperCase()
}

function getTokenTypeLabel(tokenType: GitTokenType, unknownLabel: string): string {
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
      return unknownLabel
  }
}

export function AuthSuccess({
  userInfo,
  provider,
  detectionSource,
  detectedScopes,
  detectedTokenType,
  scopeWarning,
  sessionEnvWarning,
  host,
  successMeta,
  divergenceHint,
  sessionStale,
  gitSslBackend,
  onApplySchannel,
  onReAuthenticate,
}: AuthSuccessProps) {
  // For multi-host providers (GitLab), name the instance the token belongs to so
  // a user logged into several hosts can tell gitlab.com from a self-managed one.
  const authTarget =
    provider.supportsHostSelection && host ? `${provider.label} (${host})` : provider.label
  const [showPermissions, setShowPermissions] = useState(false)
  // Avatars are hot-linked, so a CSP-blocked host (a self-hosted GitLab
  // instance, or a Gravatar host not in img-src) makes the <img> fire `error`
  // rather than render. The img-src allowlist is deliberately NOT widened per
  // instance (no new security surface) — fall back to an
  // initials avatar so the card still looks intentional.
  const [avatarFailed, setAvatarFailed] = useState(false)
  const scopeDescriptions = provider.success.scopeDescriptions
  const isFineGrainedPat = detectedTokenType === 'fine_grained_pat'
  // ghs_ installation tokens have no user context — /user returns 403 — so
  // validateToken synthesizes a user without an avatar. ghu_ tokens also
  // detect as 'github_app' but hit /user successfully and have a real avatar,
  // so they fall through to the normal user card. GitLab never reaches here
  // (showAppInstallBranch is false).
  const isAppInstallation =
    provider.success.showAppInstallBranch &&
    detectedTokenType === 'github_app' &&
    !userInfo.avatarUrl

  if (isAppInstallation) {
    return (
      <div className="mb-4">
        <div className="text-success font-semibold text-sm mb-2 flex items-center gap-2">
          <span>✓ Authenticated as GitHub App</span>
          {detectionSource && (
            <span className="text-xs bg-info-muted text-info px-2 py-0.5 rounded font-normal">
              {detectionSource === 'env' && 'From Environment'}
              {detectionSource === 'cli' && `Via ${provider.cli.label}`}
              {detectionSource === 'block' && 'From Command'}
            </span>
          )}
        </div>
        <div className="bg-success-muted/50 rounded p-3 text-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full border border-success/30 bg-card flex items-center justify-center">
              <Bot className="size-5 text-muted-foreground" />
            </div>
            <div>
              <div className="text-foreground font-medium">
                {userInfo.name || 'GitHub App Installation'}
              </div>
              <div className="text-muted-foreground text-xs">
                @{userInfo.login}
              </div>
              <div className="text-muted-foreground text-xs mt-1 flex items-center gap-1">
                <Shield className="size-3" />
                <span>GitHub App Token</span>
              </div>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-success/30 text-muted-foreground text-xs">
            GitHub Apps use installation-level permission grants instead of OAuth scopes.
            Access is scoped to the repositories the app is installed on.
          </div>
          {sessionEnvWarning && (
            <div className="mt-3 pt-3 border-t border-success/30 flex items-start gap-2 text-warning text-xs">
              <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
              <div>{sessionEnvWarning}</div>
            </div>
          )}
        </div>
        {onReAuthenticate && (
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={onReAuthenticate}>
              Use a different token
            </Button>
          </div>
        )}
      </div>
    )
  }

  // source line: name the exact env var / CLI / config-file source.
  const sourceLine =
    detectionSource === 'env'
      ? `Detected from ${successMeta?.envVar ?? 'environment'}`
      : detectionSource === 'cli'
        ? successMeta?.source === 'config'
          ? `Detected from ${provider.cli.label} config file`
          : `Detected from ${provider.cli.label}`
        : detectionSource === 'block'
          ? 'From Command'
          : null

  // transparency: probe-validated auth means the direct transport is
  // still TLS-blocked for this host.
  const cliShort = provider.cli.binary
  const transportLine =
    successMeta?.validatedVia === 'cli'
      ? `validated via ${cliShort} CLI — Runbooks' direct connection to ${host ?? provider.label} is not trusted yet`
      : null

  // Git for Windows defaults to OpenSSL, which ignores the Windows
  // certificate store — suggest (never silently apply) the schannel switch
  // for non-public GitLab hosts.
  const showSchannelSuggestion =
    provider.id === 'gitlab' &&
    gitSslBackend !== undefined &&
    gitSslBackend !== 'schannel' &&
    host !== undefined &&
    host !== 'gitlab.com'

  return (
    <div className="mb-4">
      <div className="text-success font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to {authTarget}</span>
        {sourceLine && (
          <span className="text-xs bg-info-muted text-info px-2 py-0.5 rounded font-normal">
            {sourceLine}
          </span>
        )}
      </div>

      {/* the session holds ONE credential per provider — when a
          later block authenticated a different host, this card must not imply
          its credential is still active. */}
      {sessionStale && (
        <div
          data-testid="stale-session-warning"
          className="mb-2 bg-warning-muted border border-warning/30 rounded p-2 text-xs text-warning-foreground flex items-start gap-2"
        >
          <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0" />
          <span>
            Another {provider.label} block authenticated a different host afterwards, replacing
            this session credential. Re-authenticate to use {host ?? provider.label} again.
          </span>
        </div>
      )}

      {transportLine && (
        <div
          data-testid="transport-degraded-line"
          className="mb-2 bg-warning-muted border border-warning/30 rounded p-2 text-xs text-warning-foreground flex items-start gap-2"
        >
          <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0" />
          <span>
            {transportLine}. MR/label API features need the CA installed in the OS trust store
            (macOS: Keychain Access → System keychain, <strong>'Always Trust'</strong>). git
            operations are unaffected.
          </span>
        </div>
      )}

      {divergenceHint && (
        <div data-testid="env-divergence-hint" className="mb-2 text-xs text-muted-foreground">
          {divergenceHint}
        </div>
      )}

      {showSchannelSuggestion && (
        <div
          data-testid="schannel-suggestion"
          className="mb-2 bg-info-muted border border-info/30 rounded p-2 text-xs text-info flex items-start gap-2"
        >
          <span>
            Git for Windows is using the OpenSSL backend, which ignores the Windows certificate
            store. Run: <code>git config --global http.sslBackend schannel</code>
          </span>
          {onApplySchannel && (
            <Button variant="outline" size="sm" onClick={onApplySchannel}>
              Apply
            </Button>
          )}
        </div>
      )}

      <div className="bg-success-muted/50 rounded p-3 text-sm">
        <div className="flex items-center gap-3">
          {userInfo.avatarUrl && !avatarFailed ? (
            <img
              src={userInfo.avatarUrl}
              alt={userInfo.login}
              onError={() => setAvatarFailed(true)}
              className="w-10 h-10 rounded-full border border-success/30"
            />
          ) : (
            <div
              className="w-10 h-10 rounded-full border border-success/30 bg-card flex items-center justify-center"
              role="img"
              aria-label={`${userInfo.login} avatar`}
            >
              <span className="text-sm font-semibold text-muted-foreground">
                {initialsFor(userInfo)}
              </span>
            </div>
          )}
          <div>
            <div className="text-foreground font-medium">
              {userInfo.name || userInfo.login}
            </div>
            <div className="text-muted-foreground text-xs">
              @{userInfo.login}
              {userInfo.email && ` • ${userInfo.email}`}
            </div>
            {/* Show token type */}
            {detectedTokenType && (
              <div className="text-muted-foreground text-xs mt-1 flex items-center gap-1">
                {isFineGrainedPat && <Shield className="size-3" />}
                <span>{getTokenTypeLabel(detectedTokenType, provider.success.unknownTokenLabel)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Show scopes as a collapsible section */}
        {detectedScopes && detectedScopes.length > 0 && (
          <div className="mt-3 pt-3 border-t border-success/30">
            <button
              onClick={() => setShowPermissions(!showPermissions)}
              className="flex items-center gap-1 text-xs text-muted-foreground font-medium hover:text-foreground transition-colors cursor-pointer"
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
                      className="inline-flex items-center gap-1 bg-muted text-muted-foreground px-2 py-0.5 rounded text-xs"
                      title={scopeDescriptions[scope] || scope}
                    >
                      <code className="text-[10px] font-mono">{scope}</code>
                      {scopeDescriptions[scope] && (
                        <span className="text-muted-foreground">— {scopeDescriptions[scope]}</span>
                      )}
                    </span>
                  ))}
                </div>
                <a
                  href={provider.success.scopesDocsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline mt-2"
                >
                  Learn more about these permissions
                  <ExternalLink className="size-3" />
                </a>
              </div>
            )}
          </div>
        )}

        {/* Note for fine-grained PATs (GitHub only) */}
        {provider.success.showFineGrainedNote && isFineGrainedPat && !detectedScopes?.length && (
          <div className="mt-3 pt-3 border-t border-success/30 text-muted-foreground text-xs">
            Fine-grained PATs use repository-specific permissions.{' '}
            <a
              href="https://github.com/settings/personal-access-tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              View all your tokens
              <ExternalLink className="size-3" />
            </a>
            {' '}to find this token's permissions.
          </div>
        )}
        {scopeWarning && (
          <div className="mt-3 pt-3 border-t border-success/30 flex items-start gap-2 text-warning text-xs">
            <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Missing "{provider.success.requiredScope}" scope</strong>
              <br />
              Operations on private repos, issues, and PRs may fail.
            </div>
          </div>
        )}
        {sessionEnvWarning && (
          <div className="mt-3 pt-3 border-t border-success/30 flex items-start gap-2 text-warning text-xs">
            <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
            <div>{sessionEnvWarning}</div>
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
