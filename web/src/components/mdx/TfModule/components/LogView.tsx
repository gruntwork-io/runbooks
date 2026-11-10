import { useState } from "react"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import type { LogLine } from "../hooks/useTfRun"

/** A run's log, folded until opened. While folded and running, its header shows the latest line. */
export function LogView({
  title,
  log,
  running,
}: {
  title: string
  log: readonly LogLine[]
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  if (log.length === 0) return null
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="shrink-0">{open ? title : `${title} (${log.length} lines)`}</span>
        {running && <Loader2 className="size-3 shrink-0 animate-spin" />}
        {running && !open && (
          <span className="min-w-0 truncate font-mono font-normal">{log.at(-1)?.line}</span>
        )}
      </button>
      {open && (
        <pre
          data-testid="tf-module-log"
          className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed"
        >
          {log.map((entry, i) => (
            <div
              key={i}
              className={
                entry.level === "error"
                  ? "text-destructive"
                  : entry.level === "warn"
                    ? "text-warning-foreground"
                    : "text-foreground/80"
              }
            >
              {entry.line}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}
