import { useState, type ComponentType, type ReactNode } from "react"
import {
  BookOpen,
  Bug,
  Check,
  Code,
  Download,
  FolderOpen,
  Hash,
  Link as LinkIcon,
  ListChecks,
  Monitor,
  Moon,
  Search,
  SquareTerminal,
  Sun,
  Trash2,
  X,
  type LucideProps,
} from "lucide-react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../ui/command"
import { useApi } from "@/contexts/ApiContext"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { useTheme } from "@/contexts/useTheme"
import { INSTRUCTION_MODE_NAME } from "@/contexts/InstructionModeContext.types"
import type { Theme } from "@/contexts/ThemeContext.types"
import { useDownloadLogs } from "@/hooks/useDownloadLogs"
import { formatShortcut } from "@/lib/platform"

// The same pages as the Help menu (electron/main/menu.ts).
const DOCS_URL = "https://docs.gruntwork.io/runbooks"
const ISSUES_URL = "https://github.com/gruntwork-io/runbooks/issues"

/** What App exposes to the palette. The palette reads the theme, mode and logs itself. */
export interface CommandPaletteContext {
  hasRunbookOpen: boolean
  /** Whether the generated files are on screen in the current layout. */
  generatedFilesVisible: boolean
  onOpenRunbook: () => void
  onOpenUrl: () => void
  onCloseRunbook: () => void
  /** Show or hide the generated files, whichever the current layout calls for. */
  onToggleGeneratedFiles: () => void
  /** Bring the runbook on screen in the narrow layout, where the Code tab can hide it. */
  onRevealRunbook: () => void
  onFind: () => void
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ctx: CommandPaletteContext
}

interface Command {
  id: string
  label: string
  icon: ComponentType<LucideProps>
  /** Extra words the filter matches, besides the label. */
  keywords?: string[]
  /** Shown at the right edge: a shortcut, or a check mark for the current choice. */
  trailing?: ReactNode
  disabled?: boolean
  run: () => void
}

interface CommandSection {
  heading: string
  commands: Command[]
}

interface HeadingEntry {
  level: number
  /** The heading's text, with a " (2)", " (3)"… suffix when an earlier heading reads the same. */
  label: string
  el: HTMLElement
}

// Keywords are per theme: a shared "dark mode" would make "dark" match all three.
const THEMES: {
  value: Theme
  label: string
  icon: ComponentType<LucideProps>
  keywords: string[]
}[] = [
  { value: "light", label: "Theme: Light", icon: Sun, keywords: ["appearance", "light mode"] },
  { value: "dark", label: "Theme: Dark", icon: Moon, keywords: ["appearance", "dark mode"] },
  { value: "system", label: "Theme: System", icon: Monitor, keywords: ["appearance", "auto"] },
]

/**
 * The runbook's own section headings, top to bottom. Headings that blocks
 * render for themselves (form groups, warnings, a pull request description's
 * preview) sit inside `.runbook-block` or `.markdown-preview` and are left
 * out, as are headings not on screen, such as those in a collapsed block,
 * which can't be scrolled to.
 */
function collectHeadings(): HeadingEntry[] {
  const nodes = document.querySelectorAll<HTMLElement>(
    ".markdown-body :is(h1, h2, h3, h4, h5, h6):not(.runbook-block *):not(.markdown-preview *)",
  )
  const seen = new Map<string, number>()
  const entries: HeadingEntry[] = []
  for (const el of nodes) {
    const text = (el.textContent || "").trim()
    if (!text || el.getClientRects().length === 0) continue
    const count = (seen.get(text) ?? 0) + 1
    seen.set(text, count)
    entries.push({
      level: Number(el.tagName[1]) || 1,
      label: count > 1 ? `${text} (${count})` : text,
      el,
    })
  }
  return entries
}

/**
 * The command palette (View > Command Palette…, Cmd/Ctrl+K): every action of
 * the Header menu and the native menus, searchable, plus "Jump to section",
 * which lists the runbook's headings.
 */
export function CommandPalette({ open, onOpenChange, ctx }: CommandPaletteProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} showCloseButton={false}>
      <CommandPaletteBody onOpenChange={onOpenChange} ctx={ctx} />
    </CommandDialog>
  )
}

/**
 * Rendered inside the dialog, which unmounts its content when closed, so the
 * mode, query and heading list start fresh each time the palette opens, and
 * App itself never subscribes to the theme, mode or logs contexts.
 */
function CommandPaletteBody({ onOpenChange, ctx }: Omit<CommandPaletteProps, "open">) {
  const api = useApi()
  const [mode, setMode] = useState<"commands" | "sections">("commands")
  const [query, setQuery] = useState("")
  // The runbook can't change while the modal palette is open.
  const [headings] = useState(collectHeadings)
  const { theme, setTheme } = useTheme()
  const { enabled: instructionMode, setEnabled: setInstructionMode } = useInstructionMode()
  const { hasLogs, downloadRaw, downloadJson } = useDownloadLogs()

  const openExternal = (url: string) => {
    api.invoke("native:open-external", { url }).catch((err: unknown) => {
      console.error("Failed to open the link:", err)
    })
  }
  // Main reports the outcome in a native dialog; a rejection here is the IPC itself failing.
  const manageCli = (channel: "cli:install-with-dialog" | "cli:uninstall-with-dialog") => {
    api.invoke(channel).catch((err: unknown) => {
      console.error(`Failed to run ${channel}:`, err)
    })
  }

  const runbookCommands: Command[] = [
    {
      id: "open-runbook",
      label: "Open Runbook…",
      icon: FolderOpen,
      keywords: ["file", "folder"],
      trailing: <CommandShortcut>{formatShortcut("O")}</CommandShortcut>,
      run: ctx.onOpenRunbook,
    },
    {
      id: "open-url",
      label: "Open from URL…",
      icon: LinkIcon,
      keywords: ["remote", "github", "gitlab"],
      trailing: <CommandShortcut>{formatShortcut("O", { shift: true })}</CommandShortcut>,
      run: ctx.onOpenUrl,
    },
  ]
  if (ctx.hasRunbookOpen) {
    runbookCommands.push({
      id: "close-runbook",
      label: "Close Runbook",
      icon: X,
      trailing: <CommandShortcut>{formatShortcut("W", { shift: true })}</CommandShortcut>,
      run: ctx.onCloseRunbook,
    })
  }

  const navigateCommands: Command[] = [
    {
      id: "find",
      label: "Find in page…",
      icon: Search,
      keywords: ["search"],
      trailing: <CommandShortcut>{formatShortcut("F")}</CommandShortcut>,
      run: ctx.onFind,
    },
    {
      id: "toggle-generated-files",
      label: ctx.generatedFilesVisible ? "Hide generated files" : "Show generated files",
      icon: Code,
      keywords: ["artifacts", "panel", "code", "output"],
      run: ctx.onToggleGeneratedFiles,
    },
  ]
  if (headings.length > 0) {
    navigateCommands.unshift({
      id: "jump-to-section",
      label: "Jump to section…",
      icon: Hash,
      keywords: ["heading", "go to", "outline"],
      trailing: (
        <span className="ml-auto text-xs text-muted-foreground">
          {headings.length === 1 ? "1 section" : `${headings.length} sections`}
        </span>
      ),
      run: () => {
        setQuery("")
        setMode("sections")
      },
    })
  }

  const sections: CommandSection[] = [
    { heading: "Runbook", commands: runbookCommands },
    ...(ctx.hasRunbookOpen
      ? [
          { heading: "Navigate", commands: navigateCommands },
          {
            heading: "Logs",
            commands: [
              {
                id: "download-logs-raw",
                label: "Download logs (Raw)",
                icon: Download,
                keywords: ["export", "zip"],
                disabled: !hasLogs,
                run: () => void downloadRaw(),
              },
              {
                id: "download-logs-json",
                label: "Download logs (JSON)",
                icon: Download,
                keywords: ["export", "zip"],
                disabled: !hasLogs,
                run: () => void downloadJson(),
              },
            ],
          },
        ]
      : []),
    {
      heading: "Appearance",
      commands: [
        ...THEMES.map(({ value, label, icon, keywords }): Command => ({
          id: `theme-${value}`,
          label,
          icon,
          keywords,
          trailing:
            theme === value ? (
              <>
                <Check className="ml-auto" />
                <span className="sr-only">current</span>
              </>
            ) : null,
          run: () => setTheme(value),
        })),
        {
          id: "instruction-mode",
          label: `${instructionMode ? "Turn off" : "Turn on"} ${INSTRUCTION_MODE_NAME}`,
          icon: ListChecks,
          keywords: ["mode", "interactive", "copy"],
          run: () => setInstructionMode(!instructionMode),
        },
      ],
    },
    {
      heading: "Command line",
      commands: [
        {
          id: "install-cli",
          label: "Install 'runbooks' command in PATH",
          icon: SquareTerminal,
          keywords: ["cli", "terminal", "shell"],
          run: () => manageCli("cli:install-with-dialog"),
        },
        {
          id: "uninstall-cli",
          label: "Uninstall 'runbooks' command from PATH",
          icon: Trash2,
          keywords: ["cli", "terminal", "shell", "remove"],
          run: () => manageCli("cli:uninstall-with-dialog"),
        },
      ],
    },
    {
      heading: "Help",
      commands: [
        {
          id: "docs",
          label: "Open documentation",
          icon: BookOpen,
          keywords: ["help", "learn", "guide"],
          run: () => openExternal(DOCS_URL),
        },
        {
          id: "report-issue",
          label: "Report an issue",
          icon: Bug,
          keywords: ["bug", "feedback", "github"],
          run: () => openExternal(ISSUES_URL),
        },
      ],
    },
  ]

  const runCommand = (cmd: Command) => {
    // "Jump to section" stays open to show the headings.
    if (cmd.id === "jump-to-section") {
      cmd.run()
      return
    }
    onOpenChange(false)
    // Next tick, not now: the dialog's focus trap stays armed until its
    // effects clean up after this commit, and would pull focus back from
    // anything the command focuses, such as the find bar.
    setTimeout(cmd.run, 0)
  }

  const jumpToHeading = (entry: HeadingEntry) => {
    onOpenChange(false)
    ctx.onRevealRunbook()
    // Next frame: the runbook is on screen by then, and the dialog's closing
    // animation doesn't fight the scroll.
    requestAnimationFrame(() => {
      entry.el.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mode === "sections" && e.key === "Backspace" && query.length === 0) {
      e.preventDefault()
      setMode("commands")
    }
  }

  const minLevel = Math.min(...headings.map((h) => h.level))

  return (
    <>
      <CommandInput
        placeholder={mode === "commands" ? "Type a command or search…" : "Jump to section…"}
        value={query}
        onValueChange={setQuery}
        onKeyDown={handleInputKeyDown}
      />
      <CommandList>
        <CommandEmpty>
          {mode === "sections" ? "No matching sections." : "No matching commands."}
        </CommandEmpty>

        {mode === "commands" &&
          sections.map((section) => (
            <CommandGroup key={section.heading} heading={section.heading}>
              {section.commands.map((cmd) => {
                const Icon = cmd.icon
                return (
                  <CommandItem
                    key={cmd.id}
                    value={cmd.label}
                    keywords={cmd.keywords ?? []}
                    disabled={cmd.disabled ?? false}
                    onSelect={() => runCommand(cmd)}
                  >
                    <Icon />
                    <span>{cmd.label}</span>
                    {cmd.trailing}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}

        {mode === "sections" && (
          <CommandGroup heading="Sections">
            {headings.map((entry) => (
              <CommandItem
                key={entry.label}
                value={entry.label}
                onSelect={() => jumpToHeading(entry)}
                style={{ paddingLeft: `${0.5 + (entry.level - minLevel) * 1}rem` }}
              >
                <Hash />
                <span>{entry.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      <div className="flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
        <KeyHint keys="↑↓">Navigate</KeyHint>
        <KeyHint keys="↵">{mode === "sections" ? "Jump" : "Run"}</KeyHint>
        {mode === "sections" && <KeyHint keys="⌫">Back</KeyHint>}
        <KeyHint keys="Esc">Close</KeyHint>
      </div>
    </>
  )
}

function KeyHint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-border bg-muted px-1 font-sans text-[10px] leading-4">
        {keys}
      </kbd>
      {children}
    </span>
  )
}
