import { useState } from "react"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import type { LogLine } from "../hooks/useTofuRun"

/** The lines of the log shown while it's folded. */
const LOG_TAIL = 6

/** A run's log, folded to its last lines until opened. */
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
  const shown = open ? log : log.slice(-LOG_TAIL)
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open ? title : `${title} (${log.length} lines)`}
        {running && <Loader2 className="size-3 animate-spin" />}
      </button>
      <pre
        data-testid="tofu-module-log"
        className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {shown.map((entry, i) => (
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
    </div>
  )
}
