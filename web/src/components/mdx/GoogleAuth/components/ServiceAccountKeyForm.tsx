import { useMemo } from "react"
import { Loader2, Eye, EyeOff, Upload, FileJson } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RegionPicker } from "./RegionPicker"
import type { GoogleAuthStatus } from "../types"

interface ServiceAccountKeyFormProps {
  authStatus: GoogleAuthStatus
  serviceAccountKey: string
  setServiceAccountKey: (value: string) => void
  /** Reveal toggle — the AwsAuth `showSecretKey` analogue. */
  showServiceAccountKey: boolean
  setShowServiceAccountKey: (value: boolean) => void
  /** File name set by the hook's `loadKeyFromFile`, or null when pasted. */
  keyFileName: string | null
  /**
   * Absolute path of a chosen key file. Non-null means the credential is the
   * FILE, read and validated in MAIN — its contents are deliberately never
   * loaded into this component.
   */
  keyFilePath: string | null
  /** Opens the native file picker (hook: `loadKeyFromFile`). */
  onLoadKeyFile: () => void
  /** Free-text project override, seeded from the `project` prop. */
  projectIdInput: string
  setProjectIdInput: (value: string) => void
  selectedRegion: string
  setSelectedRegion: (value: string) => void
  onSubmit: () => void
}

/** Non-secret fields worth echoing back so a masked/loaded key is identifiable. */
interface KeySummary {
  type?: string
  clientEmail?: string
  projectId?: string
}

/**
 * Service-account key tab — the CredentialsForm analogue.
 *
 * Accepts the key two ways, and they are mutually exclusive:
 *  - PASTED JSON, masked by default and never rendered as plain text unless the
 *    user explicitly reveals it; the summary line echoes only `client_email` /
 *    `project_id`, never `private_key`;
 *  - a key FILE chosen through the native picker, of which this component sees
 *    only the path and the base name. The document is read and validated in
 *    MAIN, so `private_key` never enters the renderer at all — which is also
 *    the only way keys stored outside the workspace (~/Downloads, the usual
 *    place) can be used.
 */
export function ServiceAccountKeyForm({
  authStatus,
  serviceAccountKey,
  setServiceAccountKey,
  showServiceAccountKey,
  setShowServiceAccountKey,
  keyFileName,
  keyFilePath,
  onLoadKeyFile,
  projectIdInput,
  setProjectIdInput,
  selectedRegion,
  setSelectedRegion,
  onSubmit,
}: ServiceAccountKeyFormProps) {
  const isAuthenticating = authStatus === 'authenticating'

  // Parse for display only. Never touches `private_key`; a parse failure is not
  // an error here (the user may still be typing) — main is the authority on
  // whether the key is valid.
  const summary = useMemo((): KeySummary | null => {
    const text = serviceAccountKey.trim()
    if (!text) return null
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) return null
      const record = parsed as Record<string, unknown>
      return {
        ...(typeof record.type === 'string' ? { type: record.type } : {}),
        ...(typeof record.client_email === 'string' ? { clientEmail: record.client_email } : {}),
        ...(typeof record.project_id === 'string' ? { projectId: record.project_id } : {}),
      }
    } catch {
      return null
    }
  }, [serviceAccountKey])

  const hasPastedKey = serviceAccountKey.trim().length > 0
  const usingFile = keyFilePath !== null
  const hasKey = hasPastedKey || usingFile
  const notJsonYet = hasPastedKey && summary === null
  const wrongType = summary?.type !== undefined && summary.type !== 'service_account'

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-1 gap-2">
          <label className="block text-sm font-medium text-foreground">
            Service Account Key (JSON) <span className="text-destructive">*</span>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadKeyFile}
            disabled={isAuthenticating}
          >
            <Upload className="size-4 mr-2" />
            Choose key file…
          </Button>
        </div>

        {usingFile ? (
          /* The credential is the file itself. Nothing to mask, nothing to
             reveal — MAIN reads it at submit time. */
          <div className="flex items-center gap-2 px-3 py-2 border border-input rounded-md text-sm">
            <FileJson className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="font-mono truncate" title={keyFilePath ?? undefined}>
              {keyFileName ?? keyFilePath}
            </span>
          </div>
        ) : (
        <div className="relative">
          {showServiceAccountKey ? (
            <textarea
              value={serviceAccountKey}
              onChange={(e) => setServiceAccountKey(e.target.value)}
              rows={8}
              aria-label="Service account key JSON"
              placeholder='{"type": "service_account", "project_id": "...", "private_key": "..."}'
              className="w-full px-3 py-2 pr-10 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono text-xs placeholder-muted-foreground resize-y"
              disabled={isAuthenticating}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
            />
          ) : (
            /* Masked single-line field: the key material stays out of the
               rendered text until the user asks for it. Pasting multi-line JSON
               here is fine — the whitespace collapses and the document still
               parses. */
            <input
              type="password"
              value={serviceAccountKey}
              onChange={(e) => setServiceAccountKey(e.target.value)}
              aria-label="Service account key JSON"
              placeholder="Paste the key JSON, or choose a key file"
              className="w-full px-3 py-2 pr-10 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm placeholder-muted-foreground"
              disabled={isAuthenticating}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
            />
          )}
          <button
            type="button"
            onClick={() => setShowServiceAccountKey(!showServiceAccountKey)}
            aria-label={showServiceAccountKey ? 'Hide service account key' : 'Show service account key'}
            className={`absolute right-2 text-muted-foreground hover:text-foreground ${
              showServiceAccountKey ? 'top-2' : 'top-1/2 -translate-y-1/2'
            }`}
          >
            {showServiceAccountKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        )}

        {/* Provenance + non-secret summary of whatever is currently loaded */}
        {usingFile && (
          <p className="mt-1 text-xs text-muted-foreground">
            The key stays on disk — Runbooks reads it only when you authenticate.
          </p>
        )}
        {summary && (summary.clientEmail || summary.projectId) && (
          <p className="mt-1 text-xs text-muted-foreground break-all">
            {summary.clientEmail}
            {summary.clientEmail && summary.projectId && ' • '}
            {summary.projectId && <span className="font-mono">{summary.projectId}</span>}
          </p>
        )}
        {wrongType && (
          <p className="mt-1 text-xs text-warning-foreground">
            This looks like a <span className="font-mono">{summary?.type}</span> credential, not a service account key.
          </p>
        )}
        {notJsonYet && (
          <p className="mt-1 text-xs text-muted-foreground">
            Paste the full contents of the JSON key file.
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          Project ID <span className="text-muted-foreground">(optional)</span>
        </label>
        <input
          type="text"
          value={projectIdInput}
          onChange={(e) => setProjectIdInput(e.target.value)}
          placeholder="my-project-123456"
          className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm placeholder-muted-foreground"
          disabled={isAuthenticating}
          spellCheck={false}
          autoCapitalize="none"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Leave blank to use the key's own <code className="bg-accent px-1 rounded">project_id</code>.
        </p>
      </div>

      <RegionPicker
        selectedRegion={selectedRegion}
        setSelectedRegion={setSelectedRegion}
        disabled={isAuthenticating}
      />

      <Button
        onClick={onSubmit}
        disabled={isAuthenticating || !hasKey}
        className="bg-info hover:bg-info/90 text-info-foreground"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Validating...
          </>
        ) : (
          'Authenticate'
        )}
      </Button>
    </div>
  )
}
