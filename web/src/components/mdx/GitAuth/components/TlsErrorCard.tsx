import { Globe, RefreshCw, ShieldAlert, ShieldX } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GitUnreachableInfo } from "../types"

interface TlsErrorCardProps {
  info: GitUnreachableInfo
  /** Re-runs the cold-read trust refresh + detection without an app restart. */
  onRetry: () => void
  retrying?: boolean
}

/**
 * The unreachable-host error cards (vcs-auth-v2-design.md §7): TLS (the cert
 * chain doesn't verify — local CA root and/or the server's certificate),
 * server-cert (the server's own certificate is bad), and network. Strictly
 * distinct from each other and from any token warning — an unreachable host
 * must never render as "Invalid credentials detected". The card renders ABOVE
 * the still-available manual UI, and never offers to skip verification.
 */
export function TlsErrorCard({ info, onRetry, retrying = false }: TlsErrorCardProps) {
  const { errorKind, host, coldReadOk } = info

  const Icon = errorKind === "tls" ? ShieldAlert : errorKind === "server-cert" ? ShieldX : Globe
  const heading =
    errorKind === "tls"
      ? "Invalid certificate chain"
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
              Check the local CA root and <code>{host}</code>'s server certificate.
              {coldReadOk === false && (
                <div className="mt-2 text-xs">
                  Automatic trust refresh is unavailable — restart Runbooks after fixing the
                  certificate.
                </div>
              )}
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
