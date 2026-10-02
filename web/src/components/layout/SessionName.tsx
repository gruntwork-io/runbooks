import { useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cn } from "@/lib/utils"
import { errorMessage } from "../../../../src/errors/message"
import { SESSION_NAME_MAX_LENGTH, sessionNameProblem } from "../../../../src/domain/session/names"

interface SessionNameProps {
  /** The open runbook's session name, e.g. `elegant-elephant` */
  name: string
  /** Whether the name is shown as a field to type a new one into */
  isRenaming: boolean
  onRenamingChange: (isRenaming: boolean) => void
  /** Called with the name the session has after a rename */
  onRenamed: (name: string) => void
}

// The header is the window's drag region; anything clickable in it opts out.
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties

const PILL = "rounded-full border px-2 py-0.5 text-xs text-foreground font-mono font-normal"

/**
 * The session's name in the title bar. Clicking it turns it into a field:
 * Enter renames the session, and Escape or clicking elsewhere leaves the name
 * as it was.
 */
export function SessionName({ name, isRenaming, onRenamingChange, onRenamed }: SessionNameProps) {
  if (!isRenaming) {
    return (
      <button
        type="button"
        className={cn(PILL, "flex-shrink-0 border-border cursor-pointer hover:bg-accent")}
        style={NO_DRAG}
        title="Rename session"
        data-testid="session-name"
        onClick={() => onRenamingChange(true)}
      >
        {name}
      </button>
    )
  }
  return (
    <SessionNameField
      // A session that replaces this one mid-edit starts the field over.
      key={name}
      name={name}
      onRenamed={(renamed) => {
        onRenamed(renamed)
        onRenamingChange(false)
      }}
      onCancel={() => onRenamingChange(false)}
    />
  )
}

interface SessionNameFieldProps {
  name: string
  onRenamed: (name: string) => void
  onCancel: () => void
}

function SessionNameField({ name, onRenamed, onCancel }: SessionNameFieldProps) {
  const api = useApi()
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const save = async () => {
    const requested = draft.trim()
    if (requested === name) {
      onCancel()
      return
    }
    // The main process checks again: it also knows the other sessions' names.
    const problem = sessionNameProblem(requested)
    if (problem !== undefined) {
      setError(problem)
      return
    }
    setIsSaving(true)
    try {
      const renamed = await api.invoke("session:rename", { name: requested })
      onRenamed(renamed.name)
    } catch (err) {
      setError(errorMessage(err))
      setIsSaving(false)
      inputRef.current?.focus()
    }
  }

  return (
    <form
      className="relative flex-shrink-0"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <input
        ref={inputRef}
        className={cn(
          PILL,
          "w-56 bg-bg-default outline-none focus:ring-1 focus:ring-ring",
          error === null ? "border-border" : "border-destructive",
        )}
        style={NO_DRAG}
        value={draft}
        maxLength={SESSION_NAME_MAX_LENGTH}
        disabled={isSaving}
        spellCheck={false}
        autoComplete="off"
        aria-label="Session name"
        aria-invalid={error !== null}
        data-testid="session-name-input"
        onChange={(event) => {
          // Names are lowercase; folding the case here spares a rejection.
          setDraft(event.target.value.toLowerCase())
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel()
        }}
        onBlur={() => {
          // Saving disables the field, which blurs it.
          if (!isSaving) onCancel()
        }}
      />
      {error !== null && (
        <p
          role="alert"
          className="absolute left-1/2 top-full mt-2 w-72 -translate-x-1/2 rounded-md border border-border bg-popover p-2 text-xs font-normal text-destructive shadow-md"
        >
          {error}
        </p>
      )}
    </form>
  )
}
