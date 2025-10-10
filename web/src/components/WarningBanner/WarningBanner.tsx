import { Admonition } from '@/components/mdx/Admonition/Admonition'
import { cn } from '@/lib/utils'

interface WarningBannerProps {
  warnings: string[]
  className?: string
}

export function WarningBanner({ warnings, className }: WarningBannerProps) {
  if (warnings.length === 0) {
    return null
  }

  const title = warnings.length === 1 
    ? 'Warning' 
    : `${warnings.length} Warnings`

  return (
    <div className={cn("mx-6 mt-2", className)}>
      <Admonition 
        type="warning" 
        title={title}
        closable={true}
      >
        {warnings.length === 1 ? (
          <p>{warnings[0]}</p>
        ) : (
          <ul className="list-disc list-inside space-y-1">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        )}
      </Admonition>
    </div>
  )
}

