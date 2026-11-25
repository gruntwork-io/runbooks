import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { useDisplayPath } from "@/contexts/useDisplayPath"
import type { AdcInfo, AdcPrincipalLookup } from "../types"

interface AdcPrincipalCardProps {
  lookup: AdcPrincipalLookup
  adcInfo: AdcInfo | null
}

export function AdcPrincipalCard({ lookup, adcInfo }: AdcPrincipalCardProps) {
  return (
    <div>
      <div className="block text-sm font-medium text-foreground mb-1">
        Application Default Credentials
      </div>
      <div className="text-sm bg-muted rounded-md px-3 py-2 space-y-1">
        <AdcPrincipalStatus lookup={lookup} />
        {adcInfo && <CredentialsFilePath path={adcInfo.path} />}
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        This tab signs in with these credentials. To change the account, run <LoginCommand />, then
        click <strong>Refresh</strong>.
      </p>
    </div>
  )
}

function AdcPrincipalStatus({ lookup }: { lookup: AdcPrincipalLookup }) {
  if (lookup.status === "checking") return <CheckingPrincipal />
  if (lookup.status === "signed-in") return <SignedInPrincipal principal={lookup.principal} />
  if (lookup.status === "unusable") return <UnusableCredentials reason={lookup.reason} />
  return <MissingCredentials />
}

function CheckingPrincipal() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Checking who these credentials belong to...
    </div>
  )
}

function SignedInPrincipal({ principal }: { principal: string }) {
  if (!principal) {
    return <div>Signed in. Google did not report an email address for these credentials.</div>
  }
  return (
    <div>
      Signed in as <span className="font-mono break-all">{principal}</span>
    </div>
  )
}

function UnusableCredentials({ reason }: { reason: string }) {
  return (
    <CredentialsProblem>
      <div>Google did not confirm these credentials.</div>
      <div className="break-words">{reason}</div>
      <div>
        If the login has expired, run <LoginCommand />. Then click <strong>Refresh</strong>.
      </div>
    </CredentialsProblem>
  )
}

function MissingCredentials() {
  return (
    <CredentialsProblem>
      No Application Default Credentials found. Run <LoginCommand />, then click{" "}
      <strong>Refresh</strong>.
    </CredentialsProblem>
  )
}

function CredentialsProblem({ children }: { children: ReactNode }) {
  return <div className="text-warning-foreground space-y-1">{children}</div>
}

function LoginCommand() {
  return <code className="bg-accent px-1 rounded">gcloud auth application-default login</code>
}

function CredentialsFilePath({ path }: { path: string }) {
  const displayPath = useDisplayPath()
  return (
    <div className="text-xs text-muted-foreground font-mono truncate" title={path}>
      {displayPath(path)}
    </div>
  )
}
