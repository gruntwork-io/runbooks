import { useState, useEffect, useRef } from "react"
import {
  ChevronDown,
  Download,
  FolderOpen,
  History,
  Pencil,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react"
import logoDarkAlpha from "@/assets/runbooks-logo-dark-alpha.svg"
import logoLightAlpha from "@/assets/runbooks-logo-light-alpha.svg"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { CopyIconButton } from "./CopyIconButton"
import { SessionName } from "./SessionName"
import { SessionsDialog } from "./SessionsDialog"
import { ThemeToggle } from "./ThemeToggle"
import { InstructionModeToggle } from "./InstructionModeToggle"
import { useDownloadLogs } from "@/hooks/useDownloadLogs"
import { useApi } from "@/contexts/ApiContext"
import { useTheme } from "@/contexts/useTheme"
import { formatShortcut, isMac } from "@/lib/platform"

interface HeaderProps {
  /** The open runbook's session name, e.g. `elegant-elephant`. Undefined while no runbook is open. */
  sessionName?: string | undefined
  /** The absolute path of that session's own directory */
  sessionDir?: string | undefined
  /** Called with the session's new name after the user renames it */
  onSessionRenamed: (name: string) => void
  onOpenCommandPalette: () => void
  onCloseRunbook: () => void
}

/**
 * A fixed header component that displays the branding and the open runbook's
 * session name, which the user can rename here, with a button that copies the
 * path of the session's directory. It is the app's title bar: the window has
 * no native one.
 *
 * The header uses a responsive design where mobile devices show only the
 * session name and its button, while desktop devices show the full layout
 * with branding and navigation.
 *
 * @param props - The component props
 * @param props.sessionName - The session name
 * @param props.sessionDir - The session's directory
 * @param props.onSessionRenamed - Called with the new name after a rename
 * @param props.onOpenCommandPalette - Called by the menu's Command Palette… item
 * @param props.onCloseRunbook - Called by the menu's Close Runbook item
 */
export function Header({
  sessionName,
  sessionDir,
  onSessionRenamed,
  onOpenCommandPalette,
  onCloseRunbook,
}: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isSessionsOpen, setIsSessionsOpen] = useState(false)
  // Set by the menu's Rename Session and Switch Session items. What they open
  // opens once the menu has closed: opened sooner, it would lose the focus to
  // the closing menu, and a name field that loses focus cancels the rename.
  const afterMenuClose = useRef<"rename" | "sessions" | null>(null)
  const { hasLogs, downloadRaw, downloadJson } = useDownloadLogs()
  const api = useApi()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  // The native "Preferences…" menu item (Cmd+,) opens the Header menu, which
  // is where the theme picker lives.
  useEffect(() => {
    const cleanup = api.on("menu:preferences", () => setIsMenuOpen(true))
    return cleanup
  }, [api])

  const hasRunbookOpen = sessionName !== undefined

  // The native "Rename Session…" menu item.
  useEffect(() => {
    const cleanup = api.on("menu:rename-session", () => {
      if (hasRunbookOpen) setIsRenaming(true)
    })
    return cleanup
  }, [api, hasRunbookOpen])

  // The native "Switch Session…" menu item.
  useEffect(() => api.on("menu:switch-session", () => setIsSessionsOpen(true)), [api])

  const handleResetSession = () => {
    api.invoke("native:reset-session").catch((err: unknown) => {
      console.error("Failed to reset the session:", err)
    })
  }

  // On Windows/Linux, Electron draws min/max/close controls via titleBarOverlay
  // in the top-right (~140px wide). Shift the Menu further from the edge on
  // those platforms so it doesn't sit under the overlay. macOS keeps the tight
  // right-5 position since its traffic lights live top-left.
  const menuRightClass = isMac ? "md:right-5" : "md:right-40"

  return (
    <>
      {/* data-find-ignore: find in page skips the header's always-visible
          session name, which would otherwise be the first match of every
          search for one of its words. */}
      <header
        className="w-full border-b border-border p-4 text-muted-foreground font-semibold flex fixed top-0 left-0 right-0 z-10 bg-bg-default min-h-16 select-none"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        data-find-ignore=""
      >
        <div className="absolute left-20 top-1/2 transform -translate-y-1/2">
          <img
            src={isDark ? logoLightAlpha : logoDarkAlpha}
            alt="Gruntwork Runbooks"
            className="h-8"
            draggable={false}
          />
        </div>
        <div className="flex-1 flex items-center gap-1.5 justify-end md:justify-center min-w-0 ml-24 mr-4 md:mx-48">
          {sessionName !== undefined && (
            <SessionName
              name={sessionName}
              isRenaming={isRenaming}
              onRenamingChange={setIsRenaming}
              onRenamed={onSessionRenamed}
            />
          )}
          {/* The session's own directory, where its scripts start and its files are */}
          {sessionDir !== undefined && (
            <CopyIconButton
              value={sessionDir}
              icon={FolderOpen}
              label="Copy session directory"
              copiedLabel="Session directory copied"
            />
          )}
        </div>
        <div
          className={`hidden md:block md:absolute ${menuRightClass} md:top-1/2 md:transform md:-translate-y-1/2 font-normal text-md`}
        >
          <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <DropdownMenuTrigger
              className="flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              Menu
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                const open = afterMenuClose.current
                if (open === null) return
                afterMenuClose.current = null
                // Keep the focus off the Menu button: what opens takes it.
                event.preventDefault()
                if (open === "rename") setIsRenaming(true)
                else setIsSessionsOpen(true)
              }}
            >
              {/* First, as the visible way to learn the shortcut: on Windows
                  and Linux the native menu bar is hidden, so this is the only
                  place the palette is mentioned on screen. */}
              <DropdownMenuItem onClick={onOpenCommandPalette}>
                <SquareTerminal className="size-4" />
                Command Palette…
                <DropdownMenuShortcut>{formatShortcut("K")}</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={downloadRaw}
                disabled={!hasLogs}
                className={!hasLogs ? "opacity-50 cursor-not-allowed" : ""}
              >
                <Download className="size-4" />
                Download logs (Raw)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={downloadJson}
                disabled={!hasLogs}
                className={!hasLogs ? "opacity-50 cursor-not-allowed" : ""}
              >
                <Download className="size-4" />
                Download logs (JSON)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  afterMenuClose.current = "sessions"
                }}
              >
                <History className="size-4" />
                Switch Session…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  afterMenuClose.current = "rename"
                }}
                disabled={!hasRunbookOpen}
                className={!hasRunbookOpen ? "opacity-50 cursor-not-allowed" : ""}
              >
                <Pencil className="size-4" />
                Rename Session
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleResetSession}
                disabled={!hasRunbookOpen}
                className={!hasRunbookOpen ? "opacity-50 cursor-not-allowed" : ""}
              >
                <RotateCcw className="size-4" />
                Reset Session
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onCloseRunbook}
                disabled={!hasRunbookOpen}
                className={!hasRunbookOpen ? "opacity-50 cursor-not-allowed" : ""}
              >
                <X className="size-4" />
                Close Runbook
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <ThemeToggle />
              <DropdownMenuSeparator />
              <InstructionModeToggle />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <SessionsDialog open={isSessionsOpen} onOpenChange={setIsSessionsOpen} />
    </>
  )
}
