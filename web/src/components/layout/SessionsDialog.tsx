import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import { formatTimeAgo } from "@/lib/relativeTime"
import type { ListedSession } from "../../../../src/domain/session/store"

interface SessionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The sessions of one runbook, most recently used first. */
interface RunbookSessions {
  /** The runbook's URL when it is remote, else its path. */
  runbook: string
  sessions: ListedSession[]
}

/**
 * The saved sessions, grouped by runbook with the open runbook first. Picking
 * one switches the window to it: main opens its runbook in that session. When
 * a script is running, the user is asked first, since the switch stops it.
 * Any session but the open one can be deleted, with its files and history.
 */
export function SessionsDialog({ open, onOpenChange }: SessionsDialogProps) {
  const api = useApi()
  const [sessions, setSessions] = useState<ListedSession[] | null>(null)
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  // The session being switched to, while main opens it (or clones it).
  const [switching, setSwitching] = useState<ListedSession | null>(null)
  // The session to switch to once the user agrees to stop the running script.
  const [stopFor, setStopFor] = useState<ListedSession | null>(null)
  // The session whose delete waits for the user to confirm it.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  // Bumped when the dialog closes, so a request that answers after that is ignored.
  const openCountRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const opened = openCountRef.current
    api
      .invoke("session:list")
      .then((result) => {
        if (opened === openCountRef.current) setSessions(result.sessions)
      })
      .catch((err: unknown) => {
        if (opened === openCountRef.current) setError(errorText(err, "Couldn't list the sessions"))
      })
  }, [api, open])

  const close = useCallback(() => {
    openCountRef.current++
    setSessions(null)
    setQuery("")
    setError(null)
    setSwitching(null)
    setStopFor(null)
    setConfirmingDelete(null)
    setDeleting(null)
    onOpenChange(false)
  }, [onOpenChange])

  const switchTo = useCallback(
    async (session: ListedSession, stopRunningScript: boolean) => {
      const opened = openCountRef.current
      setError(null)
      setConfirmingDelete(null)
      setSwitching(session)
      try {
        const result = await api.invoke("session:switch", {
          id: session.id,
          ...(stopRunningScript ? { stopRunningScript: true } : {}),
        })
        if (opened !== openCountRef.current) return
        setSwitching(null)
        if (result.status === "switched") close()
        else if (result.status === "script-running") setStopFor(session)
        else setError(result.error)
      } catch (err) {
        if (opened !== openCountRef.current) return
        setSwitching(null)
        setError(errorText(err, "Couldn't switch sessions"))
      }
    },
    [api, close],
  )

  const remove = useCallback(
    async (session: ListedSession) => {
      const opened = openCountRef.current
      setError(null)
      setDeleting(session.id)
      try {
        await api.invoke("session:delete", { id: session.id })
        if (opened !== openCountRef.current) return
        setSessions((current) => current?.filter((s) => s.id !== session.id) ?? null)
      } catch (err) {
        if (opened !== openCountRef.current) return
        setError(errorText(err, "Couldn't delete the session"))
      } finally {
        if (opened === openCountRef.current) {
          setDeleting(null)
          setConfirmingDelete(null)
        }
      }
    },
    [api],
  )

  const groups = useMemo(() => groupByRunbook(sessions ?? [], query), [sessions, query])
  const busy = switching !== null || deleting !== null

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sessions</DialogTitle>
            <DialogDescription>
              Open a saved session to pick up where it left off, or delete one you no longer need.
            </DialogDescription>
          </DialogHeader>

          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by session name or runbook"
            aria-label="Filter sessions"
            className="w-full rounded-md border border-input px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />

          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            {sessions === null && error === null && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading sessions…
              </p>
            )}
            {sessions !== null && sessions.length === 0 && (
              <p className="text-sm text-muted-foreground">No saved sessions yet.</p>
            )}
            {sessions !== null && sessions.length > 0 && groups.length === 0 && (
              <p className="text-sm text-muted-foreground">No sessions match {query.trim()}.</p>
            )}
            {groups.map((group) => (
              <section key={group.runbook} aria-label={group.runbook}>
                <h3
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={group.runbook}
                >
                  {group.runbook}
                </h3>
                <ul className="mt-1 space-y-1">
                  {group.sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      busy={busy}
                      switching={switching?.id === session.id}
                      confirmingDelete={confirmingDelete === session.id}
                      deleting={deleting === session.id}
                      onSwitch={() => void switchTo(session, false)}
                      onDelete={() => setConfirmingDelete(session.id)}
                      onConfirmDelete={() => void remove(session)}
                      onCancelDelete={() => setConfirmingDelete(null)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={stopFor !== null}
        onOpenChange={(next) => {
          if (!next) setStopFor(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the running script?</AlertDialogTitle>
            <AlertDialogDescription>
              A script is still running. Switching to {stopFor?.name} stops it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = stopFor
                setStopFor(null)
                if (target) void switchTo(target, true)
              }}
            >
              Stop and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface SessionRowProps {
  session: ListedSession
  /** Another switch or delete is in progress. */
  busy: boolean
  switching: boolean
  confirmingDelete: boolean
  deleting: boolean
  onSwitch: () => void
  onDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}

function SessionRow({
  session,
  busy,
  switching,
  confirmingDelete,
  deleting,
  onSwitch,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: SessionRowProps) {
  const runs =
    session.executionCount === 0
      ? "no runs"
      : `${session.executionCount} ${session.executionCount === 1 ? "run" : "runs"}`
  return (
    <li className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
        disabled={session.isCurrent || session.runbookMissing || busy}
        onClick={onSwitch}
      >
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{session.name}</span>
          {session.isCurrent && (
            <span className="rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">
              Open
            </span>
          )}
          {switching && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {session.remoteSource !== undefined ? "Cloning…" : "Opening…"}
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">
          Used {formatTimeAgo(session.lastUsedAt)}, {runs}
        </span>
        {session.runbookMissing && (
          <span className="block text-xs text-destructive">
            Its runbook is gone, so it can't be opened.
          </span>
        )}
      </button>
      {confirmingDelete ? (
        <span className="flex items-center gap-2 text-xs">
          <span>Delete its files and history?</span>
          <button
            type="button"
            className="rounded-md bg-destructive px-2 py-1 font-medium text-white disabled:opacity-50"
            disabled={deleting}
            onClick={onConfirmDelete}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1"
            disabled={deleting}
            onClick={onCancelDelete}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Delete ${session.name}`}
          title={
            session.isCurrent
              ? "Switch to another session to delete this one"
              : `Delete ${session.name}`
          }
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
          disabled={session.isCurrent || busy}
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </li>
  )
}

/**
 * The sessions matching `query` (by session name or runbook), grouped by
 * runbook. The open session's runbook comes first, then the others by their
 * most recently used session, as `sessions` lists them.
 */
function groupByRunbook(sessions: ListedSession[], query: string): RunbookSessions[] {
  const needle = query.trim().toLowerCase()
  const groups = new Map<string, RunbookSessions>()
  for (const session of sessions) {
    const runbook = session.remoteSource ?? session.path
    const matches =
      needle === "" ||
      session.name.toLowerCase().includes(needle) ||
      runbook.toLowerCase().includes(needle)
    if (!matches) continue
    const group = groups.get(runbook) ?? { runbook, sessions: [] }
    group.sessions.push(session)
    groups.set(runbook, group)
  }
  const ordered = [...groups.values()]
  const open = ordered.findIndex((group) => group.sessions.some((s) => s.isCurrent))
  if (open > 0) ordered.unshift(...ordered.splice(open, 1))
  return ordered
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? cleanIpcErrorMessage(err.message) : fallback
}
