import { Square, CheckSquare } from 'lucide-react'

/**
 * A click-to-confirm checkbox for instruction-mode blocks: the user ticks it
 * once they've performed the step by hand, and the block highlights green (the
 * container styling is applied by the parent via the same `completed` state).
 */
export function CompletionCheckbox({
  completed,
  onToggle,
}: {
  completed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={completed}
      aria-label={completed ? 'Mark step as not done' : 'Mark step as done'}
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm cursor-pointer transition-colors hover:bg-accent ${
        completed ? 'text-success font-medium' : 'text-muted-foreground'
      }`}
    >
      {completed ? (
        <CheckSquare className="size-4 text-success" />
      ) : (
        <Square className="size-4" />
      )}
      {completed ? 'Done' : 'Mark as done'}
    </button>
  )
}
