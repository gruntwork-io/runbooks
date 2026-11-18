import { Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DetectedAzureCredentials } from "../types"

interface DetectedCredentialsPromptProps {
  detected: DetectedAzureCredentials
  confirming: boolean
  onConfirm: () => void
  onReject: () => void
}

export function DetectedCredentialsPrompt({
  detected,
  confirming,
  onConfirm,
  onReject,
}: DetectedCredentialsPromptProps) {
  const fromCli = detected.source === "cli"
  return (
    <div className="mb-4">
      <div className="bg-info-muted border border-info/40 rounded-lg p-4">
        <div className="flex items-start gap-3 mb-3">
          <ShieldCheck className="size-5 text-info mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold text-foreground">Existing Azure sign-in found</div>
            <div className="text-sm text-muted-foreground">
              {fromCli
                ? "You're signed in to the Azure CLI. This block uses a copy of that sign-in; your own az login doesn't change."
                : `A service principal is set in ${detected.envVarPrefix ?? ""}* environment variables.`}{" "}
              Use it?
            </div>
          </div>
        </div>
        <div className="bg-card rounded border border-info/40 p-3 mb-3 grid gap-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground min-w-[100px]">
              {fromCli ? "Account:" : "Client ID:"}
            </span>
            <span className="font-mono text-foreground break-all">{detected.principalName}</span>
          </div>
          {detected.tenantId && (
            <div className="flex gap-2">
              <span className="text-muted-foreground min-w-[100px]">Tenant:</span>
              <span className="font-mono text-foreground">{detected.tenantId}</span>
            </div>
          )}
          {detected.subscriptionId && (
            <div className="flex gap-2">
              <span className="text-muted-foreground min-w-[100px]">Subscription:</span>
              <span className="text-foreground">
                {detected.subscriptionName ?? detected.subscriptionId}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={onConfirm}
            disabled={confirming}
            size="sm"
            className="bg-info hover:bg-info/90 text-white"
          >
            {confirming && <Loader2 className="size-4 mr-2 animate-spin" />}
            {confirming ? "Signing in…" : "Use this sign-in"}
          </Button>
          <Button onClick={onReject} disabled={confirming} variant="outline" size="sm">
            Sign in differently
          </Button>
        </div>
      </div>
    </div>
  )
}
