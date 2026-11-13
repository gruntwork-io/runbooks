import { useEffect, useRef, useState } from "react"
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useApi } from "@/contexts/ApiContext"
import { useDisplayPath } from "@/contexts/useDisplayPath"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { CaCertificateSummary, CustomCaStatus } from "../../../../src/domain/tls/custom-ca"

interface CustomCaDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })

/**
 * The custom CA setting (Custom CA Certificate…): a certificate file whose
 * certificates Runbooks trusts besides the ones it already does, for servers
 * signed by a private CA. Main shows the file dialog, reads the file and
 * installs it; this shows what it holds, and lets the user replace or remove it.
 */
export function CustomCaDialog({ open, onOpenChange }: CustomCaDialogProps) {
  const api = useApi()
  const displayPath = useDisplayPath()
  const [status, setStatusState] = useState<CustomCaStatus | null>(null)
  // When `status` arrived, which certificates' expiry dates are shown against.
  const [now, setNow] = useState(0)
  const setStatus = (next: CustomCaStatus | null) => {
    setStatusState(next)
    setNow(Date.now())
  }
  // Why the last file picked wasn't used, or why a request failed.
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Bumped when the dialog closes, so a request that answers after that is ignored.
  const openCountRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const opened = openCountRef.current
    api
      .invoke("tls:custom-ca-status")
      .then((result) => {
        if (opened === openCountRef.current) setStatus(result)
      })
      .catch((err: unknown) => {
        if (opened === openCountRef.current) setProblem(errorText(err))
      })
  }, [api, open])

  const close = () => {
    openCountRef.current++
    setStatus(null)
    setProblem(null)
    setBusy(false)
    onOpenChange(false)
  }

  const request = (run: () => Promise<void>) => {
    const opened = openCountRef.current
    setBusy(true)
    setProblem(null)
    run()
      .catch((err: unknown) => {
        if (opened === openCountRef.current) setProblem(errorText(err))
      })
      .finally(() => {
        if (opened === openCountRef.current) setBusy(false)
      })
  }

  const choose = () =>
    request(async () => {
      const opened = openCountRef.current
      const result = await api.invoke("tls:choose-custom-ca")
      if (opened !== openCountRef.current) return
      setStatus(result.status)
      if (result.rejected) setProblem(result.rejected)
    })

  const remove = () =>
    request(async () => {
      const opened = openCountRef.current
      const result = await api.invoke("tls:clear-custom-ca")
      if (opened === openCountRef.current) setStatus(result)
    })

  const isSet = status?.path !== undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Custom CA Certificate</DialogTitle>
          <DialogDescription>
            Trust a certificate authority that isn't publicly trusted, such as your organization's
            private root CA. Runbooks trusts it in addition to the certificates it already trusts,
            for its own connections and for the scripts and tools it runs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm" data-testid="custom-ca-status">
          {status === null && problem === null && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
          {status !== null && !isSet && (
            <p className="text-muted-foreground">No custom CA certificate is set.</p>
          )}
          {status?.path !== undefined && (
            <>
              <p className="truncate font-mono text-xs text-muted-foreground" title={status.path}>
                {displayPath(status.path)}
              </p>
              {status.error !== undefined && (
                <p className="flex items-start gap-2 text-destructive">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <span>Not trusted: {status.error}</span>
                </p>
              )}
              {status.certificates.length > 0 && (
                <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
                  {status.certificates.map((cert) => (
                    <CertificateRow key={cert.fingerprint256} cert={cert} now={now} />
                  ))}
                </ul>
              )}
            </>
          )}
          {problem !== null && (
            <p role="alert" className="text-destructive">
              {problem}
            </p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {isSet && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-destructive hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Done
            </button>
            <button
              type="button"
              onClick={choose}
              disabled={busy || status === null}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {isSet ? "Choose Another File…" : "Choose File…"}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One of the file's certificates: who it is, who issued it, and until when, as of `now`. */
function CertificateRow({ cert, now }: { cert: CaCertificateSummary; now: number }) {
  const expired = Date.parse(cert.validTo) < now
  return (
    <li className="flex items-start gap-2 rounded-md border border-border p-3">
      {expired ? (
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
      )}
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-foreground">{cert.subject}</p>
        <p className="text-xs text-muted-foreground">
          {cert.issuer === cert.subject ? "Self-signed" : `Issued by ${cert.issuer}`}
          {" · "}
          {expired ? (
            <span className="text-destructive">Expired {formatDate(cert.validTo)}</span>
          ) : (
            `Expires ${formatDate(cert.validTo)}`
          )}
          {!cert.isCa && " · Not a CA certificate"}
        </p>
        <p
          className="break-all font-mono text-[11px] text-muted-foreground"
          title="SHA-256 fingerprint"
        >
          {cert.fingerprint256}
        </p>
      </div>
    </li>
  )
}

const errorText = (err: unknown) =>
  err instanceof Error ? cleanIpcErrorMessage(err.message) : "Something went wrong"
