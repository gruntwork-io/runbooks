import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TenantField, INPUT_CLASSES } from "./TenantField"

interface ServicePrincipalFormProps {
  authenticating: boolean
  clientId: string
  setClientId: (value: string) => void
  tenantId: string
  setTenantId: (value: string) => void
  pinnedTenantId?: string | undefined
  clientSecret: string
  setClientSecret: (value: string) => void
  certificatePath: string
  setCertificatePath: (value: string) => void
  useCertificate: boolean
  setUseCertificate: (value: boolean) => void
  onSubmit: () => void
}

export function ServicePrincipalForm({
  authenticating,
  clientId,
  setClientId,
  tenantId,
  setTenantId,
  pinnedTenantId,
  clientSecret,
  setClientSecret,
  certificatePath,
  setCertificatePath,
  useCertificate,
  setUseCertificate,
  onSubmit,
}: ServicePrincipalFormProps) {
  const tenant = pinnedTenantId ?? tenantId
  const complete =
    clientId.trim() !== "" &&
    tenant.trim() !== "" &&
    (useCertificate ? certificatePath.trim() !== "" : clientSecret !== "")

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          Client ID <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          aria-label="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className={INPUT_CLASSES}
          disabled={authenticating}
        />
      </div>
      <TenantField
        value={tenantId}
        onChange={setTenantId}
        pinned={pinnedTenantId}
        disabled={authenticating}
        required
      />
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            checked={!useCertificate}
            onChange={() => setUseCertificate(false)}
            disabled={authenticating}
          />
          Use a client secret
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            checked={useCertificate}
            onChange={() => setUseCertificate(true)}
            disabled={authenticating}
          />
          Use a certificate
        </label>
      </div>
      {useCertificate ? (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Certificate path <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            aria-label="Certificate path"
            value={certificatePath}
            onChange={(e) => setCertificatePath(e.target.value)}
            placeholder="/path/to/service-principal.pem"
            className={INPUT_CLASSES}
            disabled={authenticating}
          />
          <p className="text-xs text-muted-foreground mt-1">
            A PEM file with the private key and certificate, as az login --certificate takes.
          </p>
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Client secret <span className="text-destructive">*</span>
          </label>
          <input
            type="password"
            aria-label="Client secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            className={INPUT_CLASSES}
            disabled={authenticating}
          />
        </div>
      )}
      <Button size="sm" onClick={onSubmit} disabled={authenticating || !complete}>
        {authenticating && <Loader2 className="size-4 mr-2 animate-spin" />}
        {authenticating ? "Signing in..." : "Sign in"}
      </Button>
    </div>
  )
}
