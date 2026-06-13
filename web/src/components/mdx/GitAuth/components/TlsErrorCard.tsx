import { Globe, RefreshCw, ShieldAlert, ShieldX } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GitUnreachableInfo } from "../types"
import type { ProviderConfig } from "../providers"

interface TlsErrorCardProps {
  info: GitUnreachableInfo
  provider: ProviderConfig
  /** Re-runs the cold-read trust refresh + detection without an app restart. */
  onRetry: () => void
  retrying?: boolean
}

/**
 * The unreachable-host error cards (vcs-auth-v2-design.md §7): TLS (custom CA
 * not trusted by Node), server-cert (the server's own certificate is bad), and
 * network. Strictly distinct from each other and from any token warning — an
 * unreachable host must never render as "Invalid credentials detected". The
 * card renders ABOVE the still-available manual UI.
 *
 * Remediation is layered for the TLS case and never offers to skip
 * verification.
 */
export function TlsErrorCard({ info, provider, onRetry, retrying = false }: TlsErrorCardProps) {
  const { errorKind, host, coldReadOk } = info
  const isGitLab = provider.id === "gitlab"

  const Icon = errorKind === "tls" ? ShieldAlert : errorKind === "server-cert" ? ShieldX : Globe
  const heading =
    errorKind === "tls"
      ? "Secure connection failed"
      : errorKind === "server-cert"
        ? "Server certificate problem"
        : "Host unreachable"

  return (
    <div
      data-testid="vcs-unreachable-card"
      data-error-kind={errorKind}
      className="mb-4 bg-destructive/10 border border-destructive/30 rounded p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <Icon className="size-4 mt-0.5 flex-shrink-0 text-destructive" />
        <div className="flex-1">
          <div className="font-semibold text-foreground mb-1">{heading}</div>

          {errorKind === "tls" && (
            <div className="text-muted-foreground">
              Could not establish a secure connection to <code>{host}</code>: its certificate is
              not trusted by this system. If your organization uses a custom certificate
              authority, install it in the OS trust store (macOS: Keychain Access → System
              keychain, set <strong>'Always Trust'</strong> for SSL — hostname-scoped or per-app
              trust is not enough, and is the likely cause if gh/glab already work on this
              machine; Windows: Trusted Root Certification Authorities), then{" "}
              {coldReadOk === false ? <>restart Runbooks.</> : <>click <strong>Retry</strong>.</>}
              {isGitLab && (
                <div className="mt-2">
                  Alternatively, point glab at the CA and reload:{" "}
                  <code>glab config set ca_cert /path/to/ca.pem --host {host}</code>
                </div>
              )}
              <div className="mt-2 text-xs">
                Advanced: launch Runbooks with <code>NODE_EXTRA_CA_CERTS=/path/to/ca.pem</code>.
              </div>
            </div>
          )}

          {errorKind === "server-cert" && (
            <div className="text-muted-foreground">
              There is a problem with <code>{host}</code>'s server certificate (expired, or issued
              for a different hostname). Installing a CA cannot fix this — contact the instance
              administrator.
            </div>
          )}

          {errorKind === "network" && (
            <div className="text-muted-foreground">
              Could not reach <code>{host}</code> (network error). Check the instance URL, VPN, or
              connectivity.
            </div>
          )}

          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={`size-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
              Retry
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
