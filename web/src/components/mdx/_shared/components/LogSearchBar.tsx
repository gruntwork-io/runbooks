import type { Ref } from "react"
import { CaseSensitive, ChevronDown, ChevronUp, ListFilter, Regex, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FIND_IGNORE_ATTRIBUTE } from "@/lib/findInPage"
import { cn } from "@/lib/utils"

/** The search's toggles. */
export type LogSearchOption = "matchCase" | "regex" | "onlyMatching"

/** Alt+C, Alt+R and Alt+L flip the toggles, by key position: Alt types other letters on macOS. */
const OPTION_KEYS: Partial<Record<string, LogSearchOption>> = {
  KeyC: "matchCase",
  KeyR: "regex",
  KeyL: "onlyMatching",
}

const TOGGLES: { option: LogSearchOption; label: string; key: string; Icon: typeof Regex }[] = [
  { option: "matchCase", label: "Match case", key: "C", Icon: CaseSensitive },
  { option: "regex", label: "Use regular expression", key: "R", Icon: Regex },
  { option: "onlyMatching", label: "Show only matching lines", key: "L", Icon: ListFilter },
]

interface LogSearchBarProps {
  inputRef: Ref<HTMLInputElement>
  query: string
  matchCase: boolean
  regex: boolean
  onlyMatching: boolean
  /** The query is a regular expression that doesn't parse. */
  invalid: boolean
  count: number
  /** The current match's index, -1 for none. */
  current: number
  onQueryChange: (query: string) => void
  onToggle: (option: LogSearchOption) => void
  onStep: (delta: 1 | -1) => void
  onClose: () => void
  className?: string
}

/**
 * The search strip under a log view's header, laid out like the find-in-page
 * bar: the query, "3 of 38", toggles for match case, regex and showing only
 * matching lines, then previous, next and close. Enter and Shift+Enter step
 * through the matches. ViewLogs owns the state and handles Escape, so that
 * Escape in maximized logs closes the search before the logs.
 */
export function LogSearchBar({
  inputRef,
  query,
  matchCase,
  regex,
  onlyMatching,
  invalid,
  count,
  current,
  onQueryChange,
  onToggle,
  onStep,
  onClose,
  className,
}: LogSearchBarProps) {
  const options = { matchCase, regex, onlyMatching }
  const status = invalid
    ? "Invalid regex"
    : !query.trim()
      ? ""
      : count === 0
        ? "No results"
        : `${current + 1} of ${count}`

  // Keep focus in the input when a button is clicked, so typing carries on.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const buttonClass = "h-6 w-6 text-muted-foreground hover:text-foreground"

  return (
    // data-find-ignore leaves the strip's own text, such as its count, out of find in page.
    <div
      role="search"
      aria-label="Search logs"
      {...{ [FIND_IGNORE_ATTRIBUTE]: "" }}
      onKeyDown={(e) => {
        if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
        const option = OPTION_KEYS[e.code]
        if (!option) return
        e.preventDefault()
        onToggle(option)
      }}
      className={cn(
        "flex flex-wrap items-center gap-1 bg-popover py-1 pr-1 pl-2.5 text-popover-foreground",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in logs"
        placeholder="Find in logs"
        aria-invalid={invalid || undefined}
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return
          e.preventDefault()
          onStep(e.shiftKey ? -1 : 1)
        }}
        className={cn(
          "h-6 max-w-88 min-w-24 flex-[1_1_10rem] rounded-sm bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          invalid &&
            "text-destructive underline decoration-destructive decoration-wavy underline-offset-4",
        )}
      />
      <span
        role="status"
        className={cn(
          "min-w-16 text-right text-xs whitespace-nowrap tabular-nums",
          invalid ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {status}
      </span>
      <span className="flex-1" />
      <span className="mx-1 h-4 w-px bg-border" />
      {TOGGLES.map(({ option, label, key, Icon }) => (
        <Button
          key={option}
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={options[option]}
          title={`${label} (Alt+${key})`}
          onMouseDown={keepFocus}
          onClick={() => onToggle(option)}
          className={cn(
            "h-6 w-6 hover:text-foreground",
            options[option] ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </Button>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={count === 0}
        onMouseDown={keepFocus}
        onClick={() => onStep(-1)}
        className={buttonClass}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={count === 0}
        onMouseDown={keepFocus}
        onClick={() => onStep(1)}
        className={buttonClass}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close search"
        title="Close (Esc)"
        onMouseDown={keepFocus}
        onClick={onClose}
        className={buttonClass}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
