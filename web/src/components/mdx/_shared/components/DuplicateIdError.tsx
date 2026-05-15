import { XCircle } from 'lucide-react'

interface DuplicateIdErrorProps {
  id: string
  isNormalizedCollision: boolean
  collidingId?: string
}

export function DuplicateIdError({ id, isNormalizedCollision, collidingId }: DuplicateIdErrorProps) {
  return (
    <div className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
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
