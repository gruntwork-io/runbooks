import { useState, useEffect, type ComponentType, type ComponentPropsWithRef } from "react"
import {
  ChevronDown,
  Download,
  Check,
  FolderOpen,
  Copy,
  SquareTerminal,
  X,
  type LucideProps,
} from "lucide-react"
import logoDarkAlpha from "@/assets/runbooks-logo-dark-alpha.svg"
import logoLightAlpha from "@/assets/runbooks-logo-light-alpha.svg"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { ThemeToggle } from "./ThemeToggle"
import { InstructionModeToggle } from "./InstructionModeToggle"
import { useDownloadLogs } from "@/hooks/useDownloadLogs"
import { useApi } from "@/contexts/ApiContext"
import { useTheme } from "@/contexts/useTheme"
import { formatShortcut, isMac } from "@/lib/platform"
import { getDirectoryPath } from "@/lib/utils"

function CopyButton({
  onClick,
  didCopy,
  icon: Icon,
  size,
  className,
  ref,
  ...props
}: {
  didCopy: boolean
  icon: ComponentType<LucideProps>
  size: string
} & ComponentPropsWithRef<"button">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-shrink-0 rounded transition-colors cursor-pointer ${className ?? ""}`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      aria-label="Copy local path"
      {...props}
      ref={ref}
    >
      {didCopy ? (
        <Check className={`${size} text-success`} />
      ) : (
        <Icon className={`${size} text-muted-foreground`} />
      )}
    </button>
  )
}

interface HeaderProps {
  pathName: string
  /** The local filesystem path (may differ from pathName when viewing a remote runbook) */
  localPath?: string | undefined
  onOpenCommandPalette: () => void
  onCloseRunbook: () => void
}

/**
 * A fixed header component that displays the branding and current file path.
 *
 * The header uses a responsive design where mobile devices show only the file path
 * centered, while desktop devices show the full layout with branding and navigation.
 *
 * When viewing a remote runbook, pathName will be the remote URL while localPath
 * will be the temp directory path. A copy button is shown to copy the local path.
 *
 * @param props - The component props
 * @param props.pathName - The display string (remote URL or local path) for the header
 * @param props.localPath - The local filesystem path (for copy button when remote)
 * @param props.onOpenCommandPalette - Called by the menu's Command Palette… item
 * @param props.onCloseRunbook - Called by the menu's Close Runbook item
 */
export function Header({ pathName, localPath, onOpenCommandPalette, onCloseRunbook }: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const { hasLogs, downloadRaw, downloadJson } = useDownloadLogs()
  const { didCopy, copy } = useCopyToClipboard()
  const api = useApi()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  // The native "Preferences…" menu item (Cmd+,) opens the Header menu, which
  // is where the theme picker lives.
  useEffect(() => {
    const cleanup = api.on("menu:preferences", () => setIsMenuOpen(true))
    return cleanup
  }, [api])

  const hasRunbookOpen = Boolean(pathName)

  // On Windows/Linux, Electron draws min/max/close controls via titleBarOverlay
  // in the top-right (~140px wide). Shift the Menu further from the edge on
  // those platforms so it doesn't sit under the overlay. macOS keeps the tight
  // right-5 position since its traffic lights live top-left.
  const menuRightClass = isMac ? "md:right-5" : "md:right-40"

  // Show the copy-local-path button when we have a local path that differs from the display name
  // (i.e., when viewing a remote runbook)
  const isRemote = localPath && localPath !== pathName
  const localDir = getDirectoryPath(localPath) || localPath

  return (
    <>
      {/* data-find-ignore: find in page skips the header's always-visible
          runbook path, which would otherwise be every search's first match. */}
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
          <div
            className="hidden md:block text-sm text-muted-foreground font-mono font-normal truncate max-w-full"
            title={pathName}
            dir="rtl"
          >
            {"\u200E"}
            {pathName}
            {"\u200E"}
          </div>
          <div
            className="md:hidden text-xs text-muted-foreground font-mono font-normal truncate max-w-full"
            title={pathName}
            dir="rtl"
          >
            {"\u200E"}
            {pathName}
            {"\u200E"}
          </div>
          {isRemote && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <CopyButton
                    onClick={() => copy(localDir || "")}
                    didCopy={didCopy}
                    icon={FolderOpen}
                    size="size-3.5"
                    className="p-1 hover:bg-accent"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-sm">
                  <p className="text-xs font-medium mb-1">Local path:</p>
                  <div className="flex items-start gap-1.5">
                    <p className="text-xs text-muted-foreground font-mono break-all">{localDir}</p>
                    <CopyButton
                      onClick={() => copy(localDir || "")}
                      didCopy={didCopy}
                      icon={Copy}
                      size="size-3"
                      className="p-0.5 hover:bg-white/10"
                    />
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
            <DropdownMenuContent align="end">
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
    </>
  )
}
