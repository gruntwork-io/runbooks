import { ExternalLink, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TenantField } from "./TenantField"

interface InteractiveSignInProps {
  deviceCodeFlow: boolean
  authenticating: boolean
  tenantId: string
  setTenantId: (value: string) => void
  pinnedTenantId?: string | undefined
  deviceCode: { verificationUri: string; userCode: string } | null
  onStart: () => void
  onCancel: () => void
}

/** The Azure CLI tab (browser sign-in) and the Device Code tab. */
export function InteractiveSignIn({
  deviceCodeFlow,
  authenticating,
  tenantId,
  setTenantId,
  pinnedTenantId,
  deviceCode,
  onStart,
  onCancel,
}: InteractiveSignInProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {deviceCodeFlow
          ? "For a remote or headless machine: open the sign-in page on any device and enter the code shown here."
          : "Signs in with az login, which opens your browser. The sign-in stays with this block and doesn't change your own az login."}
      </p>
      <TenantField
        value={tenantId}
        onChange={setTenantId}
        pinned={pinnedTenantId}
        disabled={authenticating}
        hint="Guest in another organization's tenant? Enter that tenant to sign in to it directly."
      />

      {authenticating && deviceCodeFlow && deviceCode && (
        <div
          className="bg-info-muted border border-info/40 rounded p-3 text-sm"
          data-testid="azure-device-code"
        >
          <div className="mb-2">
            Open{" "}
            <a
              href={deviceCode.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-info underline inline-flex items-center gap-1"
            >
              {deviceCode.verificationUri}
              <ExternalLink className="size-3" />
            </a>{" "}
            and enter this code:
          </div>
          <div className="font-mono text-lg font-bold tracking-widest select-all">
            {deviceCode.userCode}
          </div>
        </div>
      )}

      {authenticating && (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          {deviceCodeFlow && !deviceCode
            ? "Getting a device code..."
            : "Waiting for you to finish signing in..."}
        </div>
      )}

      <div className="flex gap-2">
        {authenticating ? (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={onStart}>
            {deviceCodeFlow ? "Get a device code" : "Sign in with browser"}
          </Button>
        )}
      </div>
    </div>
  )
}
