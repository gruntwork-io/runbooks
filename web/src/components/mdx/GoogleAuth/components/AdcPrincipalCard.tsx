import type { ReactNode } from "react"
import { AlertTriangle, Loader2, RefreshCw, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatGcloudAdcLoginCommand } from "../../../../../../src/domain/google/scopes"
import type { AdcInfo, AdcPrincipalLookup, SignedInAdcPrincipal } from "../types"

interface AdcPrincipalCardProps {
  lookup: AdcPrincipalLookup
  adcInfo: AdcInfo | null
  requiredScopes: string[]
  onReload: () => void
  reloadDisabled: boolean
}

export function AdcPrincipalCard(props: AdcPrincipalCardProps) {
  const { lookup } = props
  if (lookup.status === "checking") return <CheckingLogin />
  if (lookup.status === "signed-in") return <LoginAccount {...props} lookup={lookup} />
  return (
    <LoginProblem {...props}>
      <ProblemDetails lookup={lookup} requiredScopes={props.requiredScopes} />
    </LoginProblem>
  )
}

function CheckingLogin() {
  return (
    <div className="flex items-center gap-3 bg-muted rounded-md px-4 py-3 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Checking your gcloud login...
    </div>
  )
}

function LoginAccount(props: AdcPrincipalCardProps & { lookup: SignedInAdcPrincipal }) {
  return (
    <div className="flex items-center gap-3 bg-muted rounded-md px-4 py-3">
      <User className="size-6 shrink-0 text-info" />
      <div className="flex-1 min-w-0">
        <AccountLines principal={props.lookup.principal} adcInfo={props.adcInfo} />
      </div>
      <ReloadButton onClick={props.onReload} disabled={props.reloadDisabled} />
    </div>
  )
}

function AccountLines({ principal, adcInfo }: { principal: string; adcInfo: AdcInfo | null }) {
  if (!principal) {
    return (
      <>
        <div className="font-medium text-foreground">You will sign in with your gcloud login</div>
        <Caption path={adcInfo?.path}>Google did not report an email address for it.</Caption>
      </>
    )
  }
  return (
    <>
      <div className="text-xs text-muted-foreground">You will sign in as</div>
      <div className="font-medium text-foreground truncate">{principal}</div>
      <Caption path={adcInfo?.path}>{describeLoginKind(adcInfo)}</Caption>
    </>
  )
}

function describeLoginKind(adcInfo: AdcInfo | null): string {
  return adcInfo?.type === "service_account"
    ? "A service account, from your gcloud Application Default Credentials"
    : "From your gcloud Application Default Credentials"
}

function Caption({ path, children }: { path: string | undefined; children: ReactNode }) {
  return (
    <div className="text-xs text-muted-foreground" title={path}>
      {children}
    </div>
  )
}

function LoginProblem(props: AdcPrincipalCardProps & { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 bg-warning-muted border border-warning/40 rounded-md px-4 py-3">
      <AlertTriangle className="size-5 shrink-0 text-warning mt-0.5" />
      <div className="flex-1 min-w-0 space-y-2 text-sm">{props.children}</div>
      <ReloadButton onClick={props.onReload} disabled={props.reloadDisabled} />
    </div>
  )
}

function ProblemDetails(props: { lookup: AdcPrincipalLookup; requiredScopes: string[] }) {
  const { lookup } = props
  if (lookup.status === "unusable") return <UnconfirmedLogin reason={lookup.reason} />
  if (lookup.status === "missing-scopes") {
    return <MissingScopes missing={lookup.missingScopes} required={props.requiredScopes} />
  }
  return <NoLogin />
}

function NoLogin() {
  return (
    <>
      <div className="font-medium text-foreground">No gcloud login found</div>
      <p className="text-muted-foreground">
        In a terminal, run the command below and choose your account in the browser. Then click{" "}
        <strong>Reload</strong>.
      </p>
      <CommandLine command={formatGcloudAdcLoginCommand([])} />
    </>
  )
}

function UnconfirmedLogin({ reason }: { reason: string }) {
  return (
    <>
      <div className="font-medium text-foreground">Google did not confirm your gcloud login</div>
      <div className="font-mono text-xs break-words">{reason}</div>
      <p className="text-muted-foreground">
        If the login has expired, run the command below in a terminal. Then click{" "}
        <strong>Reload</strong>.
      </p>
      <CommandLine command={formatGcloudAdcLoginCommand([])} />
    </>
  )
}

function MissingScopes({ missing, required }: { missing: string[]; required: string[] }) {
  return (
    <>
      <div className="font-medium text-foreground">
        Your gcloud login is missing scopes this runbook needs
      </div>
      <ScopeList scopes={missing} />
      <p className="text-muted-foreground">
        To add them, run this command in a terminal. Then click <strong>Reload</strong>.
      </p>
      <CommandLine command={formatGcloudAdcLoginCommand(required)} />
      <p className="text-muted-foreground">
        Alternatively, or if Google shows "This app is blocked", sign in with another method.
      </p>
    </>
  )
}

function ScopeList({ scopes }: { scopes: string[] }) {
  return (
    <ul className="list-disc ml-4 space-y-0.5">
      {scopes.map((scope) => (
        <li key={scope} className="font-mono text-xs break-all">
          {scope}
        </li>
      ))}
    </ul>
  )
}

function CommandLine({ command }: { command: string }) {
  return (
    <code className="block bg-card border border-warning/30 rounded px-2 py-1.5 text-xs font-mono break-all">
      {command}
    </code>
  )
}

function ReloadButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <RefreshCw className="size-3.5 mr-1.5" />
      Reload
    </Button>
  )
}
