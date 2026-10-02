import { useState, useEffect, useRef } from "react"
import { ChevronDown, Download, Info, Pencil, RotateCcw, X } from "lucide-react"
import logoDarkAlpha from "@/assets/runbooks-logo-dark-alpha.svg"
import logoDarkColor from "@/assets/runbooks-logo-dark-color.svg"
import logoLightAlpha from "@/assets/runbooks-logo-light-alpha.svg"
import logoLightColor from "@/assets/runbooks-logo-light-color.svg"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { SessionDirButton } from "./SessionDirButton"
import { SessionName } from "./SessionName"
import { ThemeToggle } from "./ThemeToggle"
import { InstructionModeToggle } from "./InstructionModeToggle"
import { useLogs } from "@/contexts/useLogs"
import { useApi } from "@/contexts/ApiContext"
import { useTheme } from "@/contexts/useTheme"
import {
  createLogsZipRaw,
  createLogsZipJson,
  downloadBlob,
  generateAllLogsZipFilename,
} from "@/lib/logs"

interface HeaderProps {
  /** The open runbook's session name, e.g. `elegant-elephant`. Undefined while no runbook is open. */
  sessionName?: string | undefined
  /** The absolute path of that session's own directory */
  sessionDir?: string | undefined
  /** Called with the session's new name after the user renames it */
  onSessionRenamed: (name: string) => void
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
 */
export function Header({ sessionName, sessionDir, onSessionRenamed }: HeaderProps) {
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  // Set by the menu's Rename Session item. The name's field opens once the
  // menu has closed: opened sooner, it would lose the focus to the closing
  // menu, and a field that loses focus cancels the rename.
  const renameOnMenuClose = useRef(false)
  const { getAllLogs, hasLogs } = useLogs()
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

  const handleCloseRunbook = () => {
    api.invoke("native:close-runbook").catch((err: unknown) => {
      console.error("Failed to close the runbook:", err)
    })
  }
  const handleResetSession = () => {
    api.invoke("native:reset-session").catch((err: unknown) => {
      console.error("Failed to reset the session:", err)
    })
  }

  // On Windows/Linux, Electron draws min/max/close controls via titleBarOverlay
  // in the top-right (~140px wide). Shift the Menu further from the edge on
  // those platforms so it doesn't sit under the overlay. macOS keeps the tight
  // right-5 position since its traffic lights live top-left.
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
  const menuRightClass = isMac ? "md:right-5" : "md:right-40"

  const handleDownloadRaw = async () => {
    const logsMap = getAllLogs()
    const blob = await createLogsZipRaw(logsMap)
    downloadBlob(blob, generateAllLogsZipFilename())
  }

  const handleDownloadJson = async () => {
    const logsMap = getAllLogs()
    const blob = await createLogsZipJson(logsMap)
    downloadBlob(blob, generateAllLogsZipFilename())
  }

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
          {sessionDir !== undefined && <SessionDirButton dir={sessionDir} />}
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
                if (!renameOnMenuClose.current) return
                renameOnMenuClose.current = false
                // Keep the focus off the Menu button: the name's field takes it.
                event.preventDefault()
                setIsRenaming(true)
              }}
            >
              <DropdownMenuItem
                onClick={handleDownloadRaw}
                disabled={!hasLogs}
                className={!hasLogs ? "opacity-50 cursor-not-allowed" : ""}
              >
                <Download className="size-4" />
                Download logs (Raw)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleDownloadJson}
                disabled={!hasLogs}
                className={!hasLogs ? "opacity-50 cursor-not-allowed" : ""}
              >
                <Download className="size-4" />
                Download logs (JSON)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  renameOnMenuClose.current = true
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
                onClick={handleCloseRunbook}
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsAboutDialogOpen(true)}>
                <Info className="size-4" />
                About
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <AlertDialog open={isAboutDialogOpen} onOpenChange={setIsAboutDialogOpen}>
        <AlertDialogContent>
          <div className="relative">
            <AlertDialogHeader>
              <AlertDialogTitle className="sr-only">About Gruntwork Runbooks</AlertDialogTitle>
              <img
                src={isDark ? logoLightColor : logoDarkColor}
                alt="Gruntwork Runbooks"
                className="h-16 mb-2"
              />

              <AlertDialogDescription className="text-left space-y-4">
                <p>
                  Runbooks enables DevOps subject matter experts to capture and share their
                  expertise in a way that is easy to understand and use.
                </p>
                <p>
                  Runbooks is published by{" "}
                  <a target="_blank" rel="noreferrer" href="https://gruntwork.io">
                    Gruntwork
                  </a>{" "}
                  and is{" "}
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href="https://github.com/gruntwork-io/runbooks"
                  >
                    open source
                  </a>
                  ! Check out the{" "}
                  <a target="_blank" rel="noreferrer" href="https://runbooks.gruntwork.io">
                    Runbooks docs
                  </a>{" "}
                  for more information.
                </p>
                <AlertDialogAction
                  className="block mt-4"
                  onClick={() => setIsAboutDialogOpen(false)}
                >
                  Close
                </AlertDialogAction>
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
