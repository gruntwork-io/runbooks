import { useState, useEffect, useRef } from "react"
import {
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  History,
  Link,
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
import { ThemeToggle } from "./ThemeToggle"
import { InstructionModeToggle } from "./InstructionModeToggle"
import { RunbookProgressBar, RunbookProgressCount } from "./RunbookProgress"
import { useDownloadLogs } from "@/hooks/useDownloadLogs"
import { useApi } from "@/contexts/ApiContext"
import { useRunbookProgress } from "@/contexts/useRunbookProgress"
import { useTheme } from "@/contexts/useTheme"
import { formatShortcut, isMac } from "@/lib/platform"

interface HeaderProps {
  /** The open runbook's name, e.g. `setup-vpc`. Undefined while no runbook is open. */
  runbookName?: string | undefined
  /** The path of the open runbook's file */
  runbookFilePath?: string | undefined
  /** The URL the open runbook was opened from, if it is remote */
  remoteSource?: string | undefined
  /** The open runbook's session name, e.g. `elegant-elephant`. Undefined while no runbook is open. */
  sessionName?: string | undefined
  /** The absolute path of that session's own directory */
  sessionDir?: string | undefined
  /** Called with the session's new name after the user renames it */
  onSessionRenamed: (name: string) => void
  onOpenCommandPalette: () => void
  /** Called by the menu's Switch Session… item, once the menu has closed */
  onOpenSessions: () => void
  onCloseRunbook: () => void
}

/**
 * A fixed header component that displays the branding, the open runbook's
 * name with a button that copies its path (its URL when it is remote), and
 * its session name, which the user can rename here, with a button that copies
 * the path of the session's directory. It is the app's title bar: the window
 * has no native one.
 *
 * The header uses a responsive design where mobile devices show only the
 * session name and its button, while desktop devices show the full layout
 * with branding and navigation.
 *
 * @param props - The component props
 * @param props.runbookName - The runbook's name
 * @param props.runbookFilePath - The path of the runbook's file
 * @param props.remoteSource - The URL of a remote runbook
 * @param props.sessionName - The session name
 * @param props.sessionDir - The session's directory
 * @param props.onSessionRenamed - Called with the new name after a rename
 * @param props.onOpenCommandPalette - Called by the menu's Command Palette… item
 * @param props.onOpenSessions - Called by the menu's Switch Session… item
 * @param props.onCloseRunbook - Called by the menu's Close Runbook item
 */
export function Header({
  runbookName,
  runbookFilePath,
  remoteSource,
  sessionName,
  sessionDir,
  onSessionRenamed,
  onOpenCommandPalette,
  onOpenSessions,
  onCloseRunbook,
}: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
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

  // A remote runbook's file is in a temporary clone: its URL is where it is.
  const runbookLocation = remoteSource ?? runbookFilePath

  // The open runbook's steps: the blocks that show whether they are done
  const progress = useRunbookProgress()
  const hasSteps = progress.total > 0

  // The native "Rename Session…" menu item.
  useEffect(() => {
    const cleanup = api.on("menu:rename-session", () => {
      if (hasRunbookOpen) setIsRenaming(true)
    })
    return cleanup
  }, [api, hasRunbookOpen])

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
        {/* md:mx-60 clears the logo on the left and, on Windows and Linux, the
            Menu beside the window controls on the right: a long runbook name
            fills the space between them. */}
        <div className="flex-1 flex items-center gap-1.5 justify-end md:justify-center min-w-0 ml-24 mr-4 md:mx-60">
          {runbookName !== undefined && (
            <div className="hidden md:flex items-center gap-1.5 min-w-0">
              {runbookLocation !== undefined && (
                <CopyIconButton
                  value={runbookLocation}
                  icon={remoteSource !== undefined ? Link : FileText}
                  label={remoteSource !== undefined ? "Copy runbook URL" : "Copy runbook path"}
                  copiedLabel={
                    remoteSource !== undefined ? "Runbook URL copied" : "Runbook path copied"
                  }
                />
              )}
              {/* The name alone, as the title: the button before it copies
                  where the runbook is. */}
              <span
                className="truncate text-sm text-foreground"
                // Out of the drag region, which gets no hover: a cut-off name
                // shows in full in its tooltip.
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                title={runbookName}
                data-testid="runbook-name"
              >
                {runbookName}
              </span>
              <span aria-hidden className="mx-2 h-4 border-l border-border" />
            </div>
          )}
          {sessionName !== undefined && (
            <>
              {/* Says what the second name is: the two are both short slugs.
                  Dropped below lg, with the step count, so a narrow window
                  leaves room for the runbook's name. */}
              <span className="hidden lg:inline flex-shrink-0 text-xs font-normal">Session</span>
              <SessionName
                name={sessionName}
                isRenaming={isRenaming}
                onRenamingChange={setIsRenaming}
                onRenamed={onSessionRenamed}
              />
            </>
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
          {hasSteps && (
            <div className="hidden lg:flex items-center ml-1.5 pl-3 border-l border-border">
              <RunbookProgressCount progress={progress} />
            </div>
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
                else onOpenSessions()
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
        {hasSteps && <RunbookProgressBar progress={progress} />}
      </header>
    </>
  )
}
