import { Pencil } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'

/**
 * AuthorModeExplainer is the one-time explainer dialog that fires the
 * first time a user enables Author Mode. Author Mode changes execution-
 * adjacent behavior (no drift warnings, hot-reload, registry panel
 * visible), so we want users to opt in deliberately rather than
 * stumble in via a keyboard shortcut.
 *
 * Persistence is handled by the parent: this dialog is purely visual
 * and calls onAcknowledge once the user dismisses it. The parent flips
 * the localStorage flag so the dialog never reappears.
 */
export interface AuthorModeExplainerProps {
  open: boolean
  onAcknowledge: () => void
}

export function AuthorModeExplainer({ open, onAcknowledge }: AuthorModeExplainerProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onAcknowledge() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center rounded-full bg-amber-100 p-2">
              <Pencil className="size-5 text-amber-700" />
            </span>
            Author Mode is on
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                You toggled Author Mode. While it’s on, Gruntbooks behaves
                as the gruntbook author would expect:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  Edits to <code className="text-xs">gruntbook.mdx</code>,
                  scripts, templates, or checks <strong>hot-reload</strong>
                  immediately — no drift warning.
                </li>
                <li>MDX parse errors and registry validation errors are surfaced inline.</li>
                <li>Block IDs and the executable registry panel become visible.</li>
              </ul>
              <p>
                Toggle it back off any time from the View menu (or
                <kbd className="ml-1 px-1.5 py-0.5 text-xs rounded border bg-muted">⇧⌘A</kbd>).
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onAcknowledge}>Got it</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
