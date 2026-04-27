import { Pencil } from 'lucide-react'

/**
 * AuthorModeBadge is the persistent "Author Mode" indicator rendered in
 * the chrome whenever the user has Author Mode active. The amber tone
 * intentionally differs from the rest of the chrome so the user can't
 * miss that they are in the hot-reload-without-warning posture.
 */
export function AuthorModeBadge() {
  return (
    <span
      title="Author Mode is on. Edits hot-reload without a drift warning."
      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 select-none"
    >
      <Pencil className="size-3" />
      Author Mode
    </span>
  )
}
