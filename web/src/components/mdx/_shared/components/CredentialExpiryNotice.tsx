import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EXPIRY_WARNING_MS, type CredentialExpiry } from "../hooks/useCredentialExpiry"

interface CredentialExpiryNoticeProps {
  /** When the credential expires, as an ISO timestamp */
  expiresAt: string
  expiry: CredentialExpiry
  onSignInAgain: () => void
}

/**
 * The notice an auth block shows when its credential has expired, or expires
 * within minutes, with a button that starts a new sign-in. Nothing while the
 * credential is valid.
 */
export function CredentialExpiryNotice({
  expiresAt,
  expiry,
  onSignInAgain,
}: CredentialExpiryNoticeProps) {
  if (expiry === "valid") return null
  const time = new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })

  return (
    <div
      role="alert"
      className="mb-4 p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2"
    >
      <AlertTriangle className="size-4 text-destructive mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-destructive m-0">
          {expiry === "expired"
            ? "These credentials have expired"
            : `These credentials expire in less than ${EXPIRY_WARNING_MS / 60_000} minutes`}
        </p>
        <p className="text-xs text-destructive m-0 mt-0.5">
          {expiry === "expired" ? `They expired at ${time}.` : `They expire at ${time}.`} Sign in
          again to keep running the blocks that use them.
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onSignInAgain}>
          Sign in again
        </Button>
      </div>
    </div>
  )
}
