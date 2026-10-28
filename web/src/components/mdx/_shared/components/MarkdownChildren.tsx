import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface MarkdownChildrenProps {
  children: ReactNode
  className?: string
}

/**
 * Markdown the author wrote as a block's children, such as an <Admonition>'s
 * body or a <Finish> block's next steps. App.css strips list markers and
 * margins from everything inside a .runbook-block, which suits the block's own
 * chrome but not the author's markdown, so this gives lists their bullets and
 * numbers back, spaces paragraphs apart, and keeps a leading heading's top
 * margin from pushing the content down.
 */
export function MarkdownChildren({ children, className }: MarkdownChildrenProps) {
  return (
    <div
      className={cn(
        "space-y-2 [&>:first-child]:mt-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6",
        className,
      )}
    >
      {children}
    </div>
  )
}
