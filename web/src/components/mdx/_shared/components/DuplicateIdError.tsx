import { XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DuplicateIdErrorProps {
  id: string
  isNormalizedCollision: boolean
  collidingId?: string
  /**
   * When set, renders the "named" variant that references the component tag,
   * e.g. `Another <Command> component with id "x" already exists.` When omitted,
   * renders the generic variant (`Another component already uses id="x".`) used
   * by Inputs/TemplateInline.
   */
  componentName?: string
  /**
   * Append "Each component must have a unique ID." after the named-variant
   * message. Ignored for the generic variant (which carries its own uniqueness
   * sentence). Defaults to false.
   */
  showUniquenessHint?: boolean
  /** Extra classes for the outer container (e.g. "runbook-block"). */
  className?: string
}

export function DuplicateIdError({
  id,
  isNormalizedCollision,
  collidingId,
  componentName,
  showUniquenessHint = false,
  className,
}: DuplicateIdErrorProps) {
  return (
    <div className={cn('relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4', className)}>
      <div className="flex items-center text-destructive">
        <XCircle className="size-6 mr-4 flex-shrink-0" />
        <div className="text-md">
          {isNormalizedCollision ? (
            <>
              <strong>ID Collision:</strong><br />
              The ID <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> collides with{' '}
              <code className="bg-destructive-muted px-1 rounded">{`"${collidingId}"`}</code> because
              hyphens are converted to underscores for template access.
              Use different IDs to avoid this collision.
            </>
          ) : componentName ? (
            <>
              <strong>Duplicate Component ID:</strong><br />
              Another <code className="bg-destructive-muted px-1 rounded">{`<${componentName}>`}</code> component with id <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> already exists.
              {showUniquenessHint ? ' Each component must have a unique ID.' : null}
            </>
          ) : (
            <>
              <strong>Duplicate ID Error:</strong> Another component already uses id=&quot;{id}&quot;.
              Each component must have a unique id.
            </>
          )}
        </div>
      </div>
    </div>
  )
}
