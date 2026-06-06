import { useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useApi } from '@/contexts/ApiContext'

interface OpenUrlModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const REMOTE_PREFIXES = ['http://', 'https://', 'git::']
const REMOTE_SHORTHAND = /^(github\.com|gitlab\.com)\//

function looksLikeRemoteUrl(input: string): boolean {
  const trimmed = input.trim()
  return REMOTE_PREFIXES.some((p) => trimmed.startsWith(p)) || REMOTE_SHORTHAND.test(trimmed)
}

export function OpenUrlModal({ open, onOpenChange }: OpenUrlModalProps) {
  const api = useApi()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const reset = useCallback(() => {
    setUrl('')
    setError(null)
    setIsLoading(false)
  }, [])

  const handleClose = useCallback(() => {
    reset()
    onOpenChange(false)
  }, [reset, onOpenChange])

  const handleSubmit = useCallback(async () => {
    const trimmed = url.trim()
    if (!trimmed) return

    if (!looksLikeRemoteUrl(trimmed)) {
      setError('Please enter a GitHub, GitLab, or git:: URL')
      return
    }

    setError(null)
    setIsLoading(true)

    try {
      await api.invoke('runbook:open-remote', { url: trimmed })
      reset()
      onOpenChange(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to open remote runbook')
      setIsLoading(false)
    }
  }, [url, api, onOpenChange, reset])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !isLoading) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit, isLoading],
  )

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open from URL</DialogTitle>
          <DialogDescription>
            Paste a GitHub or GitLab URL to a runbook directory or file.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder="https://github.com/owner/repo/tree/main/path/to/runbook"
            className="w-full rounded-md border border-input px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
            disabled={isLoading}
          />

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!url.trim() || isLoading}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isLoading ? 'Cloning...' : 'Open'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
