import type { ReactNode } from "react"
import { ExternalLink } from "lucide-react"

export function MethodLead({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

export function SetupGuide({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="text-sm">
      <summary className="text-info cursor-pointer">{question}</summary>
      <div className="mt-2 p-3 bg-muted rounded border border-border text-muted-foreground space-y-2">
        {children}
      </div>
    </details>
  )
}

export function GuideSteps({ children }: { children: ReactNode }) {
  return <ol className="ml-4 list-decimal space-y-1">{children}</ol>
}

export function GuideLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-info hover:underline inline-flex items-center gap-0.5"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  )
}

export function GuideCommand({ children }: { children: string }) {
  return <code className="bg-accent px-1 rounded text-foreground">{children}</code>
}
