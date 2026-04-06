import { useState, useEffect, useCallback } from 'react'
import { FileText, Terminal, Mouse, Globe, Check, Download, Loader2 } from 'lucide-react'
import { useApi } from '@/contexts/ApiContext'
import logoDarkColor from '@/assets/runbooks-logo-dark-color.svg'

interface WelcomeScreenProps {
  onOpenUrl?: () => void
  onOpenRunbook?: () => void
}

export function WelcomeScreen({ onOpenUrl, onOpenRunbook }: WelcomeScreenProps) {
  const api = useApi()
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null)
  const [cliLoading, setCliLoading] = useState(false)

  useEffect(() => {
    api.invoke<{ installed: boolean }>('cli:check-install')
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
          src={logoDarkColor}
          alt="Gruntwork Runbooks"
          className="h-20 mx-auto mb-6"
        />
        <p className="text-gray-500 text-lg mb-10">
          Open a runbook to get started.
        </p>

        <div className="grid gap-4 text-left">
          <button
            type="button"
            onClick={onOpenRunbook}
            className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors cursor-pointer w-full"
          >
            <FileText className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-700">Open Runbook</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Browse for a runbook file or directory, or press <kbd className="px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono text-[10px]">&#8984;O</kbd>
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenUrl}
            className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors cursor-pointer w-full"
          >
            <Globe className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-700">Open from URL</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Paste a GitHub or GitLab URL to a runbook
              </p>
            </div>
          </button>

          {cliInstalled ? (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
              <Terminal className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-gray-700">Open from the command line</p>
                  <span className="inline-flex items-center gap-1 text-[10px] text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full font-medium">
                    <Check className="w-3 h-3" />
                    Installed
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  <code className="bg-gray-200 px-1.5 py-0.5 rounded font-mono text-[11px] text-gray-600">runbooks ./path/to/runbook.mdx</code>
                </p>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleInstallCli}
              disabled={cliLoading || cliInstalled === null}
              className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors cursor-pointer w-full disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Terminal className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-gray-700">Install command line tool</p>
                  {cliLoading ? (
                    <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5 text-blue-500" />
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  Install the <code className="bg-gray-200 px-1 rounded font-mono text-[11px] text-gray-600">runbooks</code> command in your PATH to open runbooks from the terminal
                </p>
              </div>
            </button>
          )}

          <div className="flex items-start gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
            <Mouse className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-700">Drag &amp; drop</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Drop a runbook file or directory onto this window
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
