import { useState, useEffect, useCallback } from 'react'
import { FileText, Terminal, Mouse, Globe, Check, Download, Loader2 } from 'lucide-react'
import { useApi } from '@/contexts/ApiContext'
import { useTheme } from '@/contexts/useTheme'
import logoDarkColor from '@/assets/runbooks-logo-dark-color.svg'
import logoLightColor from '@/assets/runbooks-logo-light-color.svg'

interface WelcomeScreenProps {
  onOpenUrl?: () => void
  onOpenRunbook?: () => void
}

export function WelcomeScreen({ onOpenUrl, onOpenRunbook }: WelcomeScreenProps) {
  const api = useApi()
  const { resolvedTheme } = useTheme()
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null)
  const [cliLoading, setCliLoading] = useState(false)

  useEffect(() => {
    api.invoke('cli:check-install')
      .then((result) => setCliInstalled(result.installed))
      .catch(() => setCliInstalled(false))
  }, [api])

  const handleInstallCli = useCallback(async () => {
    setCliLoading(true)
    try {
      await api.invoke('cli:install')
      setCliInstalled(true)
    } catch {
      // User cancelled or error — ignore
    } finally {
      setCliLoading(false)
    }
  }, [api])

  return (
    <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
      <div className="text-center max-w-lg mx-auto px-6">
        <img
          src={resolvedTheme === 'dark' ? logoLightColor : logoDarkColor}
          alt="Gruntwork Runbooks"
          className="h-20 mx-auto mb-6"
        />
        <p className="text-muted-foreground text-lg mb-10">
          Open a runbook to get started.
        </p>

        <div className="grid gap-4 text-left">
          <button
            type="button"
            onClick={onOpenRunbook}
            className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted text-left hover:border-info/40 hover:bg-info-muted transition-colors cursor-pointer w-full"
          >
            <FileText className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Open Runbook</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Browse for a runbook file or directory, or press <kbd className="px-1.5 py-0.5 rounded bg-accent text-muted-foreground font-mono text-[10px]">&#8984;O</kbd>
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenUrl}
            className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted text-left hover:border-info/40 hover:bg-info-muted transition-colors cursor-pointer w-full"
          >
            <Globe className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Open from URL</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste a GitHub or GitLab URL to a runbook
              </p>
            </div>
          </button>

          {cliInstalled ? (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted">
              <Terminal className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">Open from the command line</p>
                  <span className="inline-flex items-center gap-1 text-[10px] text-success bg-success-muted px-1.5 py-0.5 rounded-full font-medium">
                    <Check className="w-3 h-3" />
                    Installed
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  <code className="bg-accent px-1.5 py-0.5 rounded font-mono text-[11px] text-muted-foreground">runbooks ./path/to/runbook.mdx</code>
                </p>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleInstallCli}
              disabled={cliLoading || cliInstalled === null}
              className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted text-left hover:border-info/40 hover:bg-info-muted transition-colors cursor-pointer w-full disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Terminal className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">Install command line tool</p>
                  {cliLoading ? (
                    <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5 text-primary" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Install the <code className="bg-accent px-1 rounded font-mono text-[11px] text-muted-foreground">runbooks</code> command in your PATH to open runbooks from the terminal
                </p>
              </div>
            </button>
          )}

          <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted">
            <Mouse className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Drag &amp; drop</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Drop a runbook file or directory onto this window
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
