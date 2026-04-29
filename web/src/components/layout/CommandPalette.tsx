import { useMemo, useState, type ComponentType } from "react"
import {
  BookOpen,
  Code,
  Download,
  FolderOpen,
  Hash,
  Info,
  Link as LinkIcon,
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
import { useDownloadLogs } from "@/hooks/useDownloadLogs"

export interface CommandPaletteContext {
  hasRunbookOpen: boolean
  onOpenRunbook: () => void
  onOpenUrl: () => void
  onCloseRunbook: () => void
  onToggleArtifacts: () => void
  onToggleMobileView: () => void
  onShowAbout: () => void
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ctx: CommandPaletteContext
}

interface RootCommand {
  id: string
  label: string
  icon: ComponentType<LucideProps>
  shortcut?: string
  disabled?: boolean
  run: () => void | "enter-sections"
}

interface SectionEntry {
  level: number
  text: string
  el: HTMLElement
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
const mod = isMac ? "⌘" : "Ctrl+"

function collectSections(): SectionEntry[] {
  const nodes = document.querySelectorAll<HTMLElement>(".markdown-body :is(h1, h2, h3, h4, h5, h6)")
  const entries: SectionEntry[] = []
  for (const el of nodes) {
    const text = (el.textContent || "").trim()
    if (!text) continue
    const level = Number(el.tagName[1]) || 1
    entries.push({ level, text, el })
  }
  return entries
}

export function CommandPalette({ open, onOpenChange, ctx }: CommandPaletteProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandPaletteBody onOpenChange={onOpenChange} ctx={ctx} />
    </CommandDialog>
  )
}

// Rendered inside the dialog, which unmounts its content when closed, so the
// mode and query reset to the root list each time the palette opens.
function CommandPaletteBody({ onOpenChange, ctx }: Omit<CommandPaletteProps, "open">) {
  const [mode, setMode] = useState<"root" | "sections">("root")
  const [query, setQuery] = useState("")
  const [sections, setSections] = useState<SectionEntry[]>([])
  const { hasLogs, downloadRaw, downloadJson } = useDownloadLogs()

  const rootCommands: RootCommand[] = useMemo(() => {
    const list: RootCommand[] = [
      {
        id: "open-runbook",
        label: "Open Runbook…",
        icon: FolderOpen,
        shortcut: `${mod}O`,
        run: () => ctx.onOpenRunbook(),
      },
      {
        id: "open-url",
        label: "Open from URL…",
        icon: LinkIcon,
        shortcut: isMac ? "⇧⌘O" : "Ctrl+Shift+O",
        run: () => ctx.onOpenUrl(),
      },
      {
        id: "close-runbook",
        label: "Close Runbook",
        icon: X,
        shortcut: isMac ? "⇧⌘W" : "Ctrl+Shift+W",
        disabled: !ctx.hasRunbookOpen,
        run: () => ctx.onCloseRunbook(),
      },
      {
        id: "jump-to-section",
        label: "Jump to section…",
        icon: Hash,
        disabled: !ctx.hasRunbookOpen,
        run: () => "enter-sections",
      },
      {
        id: "toggle-artifacts",
        label: "Toggle artifacts panel",
        icon: Code,
        disabled: !ctx.hasRunbookOpen,
        run: () => ctx.onToggleArtifacts(),
      },
      {
        id: "toggle-mobile-view",
        label: "Toggle markdown / code view",
        icon: BookOpen,
        disabled: !ctx.hasRunbookOpen,
        run: () => ctx.onToggleMobileView(),
      },
      {
        id: "download-logs-raw",
        label: "Download logs (Raw)",
        icon: Download,
        disabled: !hasLogs,
        run: () => void downloadRaw(),
      },
      {
        id: "download-logs-json",
        label: "Download logs (JSON)",
        icon: Download,
        disabled: !hasLogs,
        run: () => void downloadJson(),
      },
      {
        id: "about",
        label: "About Runbooks",
        icon: Info,
        run: () => ctx.onShowAbout(),
      },
    ]
    return list
  }, [ctx, hasLogs, downloadRaw, downloadJson])

  const minLevel = sections.length > 0 ? Math.min(...sections.map((s) => s.level)) : 1

  const runRootCommand = (cmd: RootCommand) => {
    if (cmd.disabled) return
    const result = cmd.run()
    if (result === "enter-sections") {
      setSections(collectSections())
      setQuery("")
      setMode("sections")
      return
    }
    onOpenChange(false)
  }

  const jumpToSection = (entry: SectionEntry) => {
    onOpenChange(false)
    // Defer to next frame so the dialog close animation doesn't fight the scroll.
    requestAnimationFrame(() => {
      entry.el.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mode === "sections" && e.key === "Backspace" && query.length === 0) {
      e.preventDefault()
      setMode("root")
    }
  }

  return (
    <>
      <CommandInput
        placeholder={mode === "root" ? "Type a command or search…" : "Jump to section…"}
        value={query}
        onValueChange={setQuery}
        onKeyDown={handleInputKeyDown}
      />
      <CommandList>
        <CommandEmpty>
          {mode === "sections" ? "No matching sections." : "No commands found."}
        </CommandEmpty>

        {mode === "root" && (
          <CommandGroup heading="Commands">
            {rootCommands.map((cmd) => {
              const Icon = cmd.icon
              return (
                <CommandItem
                  key={cmd.id}
                  value={cmd.label}
                  disabled={cmd.disabled ?? false}
                  onSelect={() => runRootCommand(cmd)}
                >
                  <Icon />
                  <span>{cmd.label}</span>
                  {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {mode === "sections" && (
          <CommandGroup heading="Sections">
            {sections.map((entry, i) => {
              const indent = "  ".repeat(Math.max(0, entry.level - minLevel))
              return (
                <CommandItem
                  key={`${i}-${entry.text}`}
                  value={entry.text}
                  onSelect={() => jumpToSection(entry)}
                >
                  <Hash />
                  <span className="font-mono whitespace-pre">{indent}</span>
                  <span>{entry.text}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
    </>
  )
}
