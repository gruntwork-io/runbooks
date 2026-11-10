import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, FolderOpen, History, Pencil, RotateCcw } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { SessionNameField } from "./SessionNameField"
import { useApi } from "@/contexts/ApiContext"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

interface SessionMenuProps {
  /** The open runbook's session name, e.g. `elegant-elephant`. Undefined while no runbook is open. */
  sessionName?: string | undefined
  /** The absolute path of that session's own directory */
  sessionDir?: string | undefined
  /** Called with the session's new name after the user renames it */
  onSessionRenamed: (name: string) => void
  /** Called by the Switch Session… item, once the menu has closed */
  onOpenSessions: () => void
}

// The header is the window's drag region; anything clickable in it opts out.
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties

const DISABLED = "opacity-50 cursor-not-allowed"

/**
 * The title bar's Session menu: its button names the open runbook's session,
 * and its items act on sessions. Rename Session turns the button into a field
 * for the new name. With no runbook open, only Switch Session… is enabled.
 */
export function SessionMenu({
  sessionName,
  sessionDir,
  onSessionRenamed,
  onOpenSessions,
}: SessionMenuProps) {
  const api = useApi()
  const [isRenaming, setIsRenaming] = useState(false)
  // Set by the Rename Session and Switch Session items. What they open opens
  // once the menu has closed: opened sooner, it would lose the focus to the
  // closing menu, and a name field that loses focus cancels the rename.
  const afterMenuClose = useRef<"rename" | "sessions" | null>(null)
  const { didCopy, copy } = useCopyToClipboard()
  const hasSession = sessionName !== undefined

  // The native "Rename Session…" menu item.
  useEffect(() => {
    const cleanup = api.on("menu:rename-session", () => {
      if (hasSession) setIsRenaming(true)
    })
    return cleanup
  }, [api, hasSession])

  const handleResetSession = () => {
    api.invoke("native:reset-session").catch((err: unknown) => {
      console.error("Failed to reset the session:", err)
    })
  }

  if (isRenaming && sessionName !== undefined) {
    return (
      <SessionNameField
        // A session that replaces this one mid-edit starts the field over.
        key={sessionName}
        name={sessionName}
        onRenamed={(renamed) => {
          onSessionRenamed(renamed)
          setIsRenaming(false)
        }}
        onCancel={() => setIsRenaming(false)}
      />
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex min-w-0 items-center gap-1.5 cursor-pointer hover:text-foreground transition-colors"
        style={NO_DRAG}
      >
        Session
        {hasSession && (
          <span
            className="truncate max-w-40 font-mono text-xs text-foreground"
            title={sessionName}
            data-testid="session-name"
          >
            {sessionName}
          </span>
        )}
        <ChevronDown className="size-4 flex-shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const open = afterMenuClose.current
          if (open === null) return
          afterMenuClose.current = null
          // Keep the focus off the Session button: what opens takes it.
          event.preventDefault()
          if (open === "rename") setIsRenaming(true)
          else onOpenSessions()
        }}
      >
        <DropdownMenuItem
          onClick={() => {
            afterMenuClose.current = "rename"
          }}
          disabled={!hasSession}
          className={!hasSession ? DISABLED : ""}
        >
          <Pencil className="size-4" />
          Rename Session
        </DropdownMenuItem>
        <DropdownMenuItem
          // Stays open to say the directory was copied.
          onSelect={(event) => event.preventDefault()}
          onClick={() => {
            if (sessionDir !== undefined) void copy(sessionDir)
          }}
          disabled={sessionDir === undefined}
          className={sessionDir === undefined ? DISABLED : ""}
        >
          {didCopy ? <Check className="size-4 text-success" /> : <FolderOpen className="size-4" />}
          {didCopy ? "Session directory copied" : "Copy session directory"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleResetSession}
          disabled={!hasSession}
          className={!hasSession ? DISABLED : ""}
        >
          <RotateCcw className="size-4" />
          Reset Session
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
