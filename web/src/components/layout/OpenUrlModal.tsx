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

export function OpenUrlModal({ open, onOpenChange }: OpenUrlModalProps) {
  const api = useApi()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = useCallback(async () => {
    const trimmed = url.trim()
    if (!trimmed) return

    setError(null)
    setIsLoading(true)

    try {
      await api.invoke('runbook:open-remote', { url: trimmed })
      setUrl('')
      onOpenChange(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to open remote runbook')
    } finally {
      setIsLoading(false)
    }
  }, [url, api, onOpenChange])

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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
            disabled={isLoading}
          />

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!url.trim() || isLoading}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isLoading ? 'Cloning...' : 'Open'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
