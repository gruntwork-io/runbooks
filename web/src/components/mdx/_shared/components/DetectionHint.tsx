interface DetectionHintProps {
  /** What the user can do instead: sign in below, fix a credential, log in with a CLI. */
  hint: string
  /** Looks for existing credentials again. Without it the row is the hint alone. */
  onCheckAgain?: (() => void) | undefined
}

/**
 * The line an auth block shows above its sign-in form: a hint, then "Check
 * again", which re-runs credential detection. Every auth block renders this
 * one component, so the control reads and sits the same in each.
 */
export function DetectionHint({ hint, onCheckAgain }: DetectionHintProps) {
  return (
    <div
      data-testid="detection-hint"
      className="mb-4 text-sm text-muted-foreground flex items-center gap-2 flex-wrap"
    >
      <span>{hint}</span>
      {onCheckAgain && (
        <button
          type="button"
          onClick={onCheckAgain}
          className="text-info hover:underline cursor-pointer text-sm font-medium"
        >
          Check again
        </button>
      )}
    </div>
  )
}
