import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Bot, X } from "lucide-react"
import { useApi } from "./ApiContext"
import {
  AgentBridgeContext,
  type AgentBlockAdapter,
  type AgentBridgeContextType,
} from "./AgentBridgeContext.types"
import { normalizeBlockId } from "@/lib/utils"
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
import type {
  AgentBlockDetail,
  AgentBlockSummary,
  AgentRequest,
  AgentServerStatus,
  AgentSession,
} from "../../../src/domain/agent/protocol"

/** How long after an agent's last request the window still says one is connected. */
const ACTIVE_FOR_MS = 2 * 60 * 1000
/** How long run_block waits to see the run start before it answers. */
const RUN_START_WAIT_MS = 3000

/** What the user has to do for a block an agent can't control. */
const NOT_CONTROLLABLE_NOTE =
  "An agent can't run this block: it needs the user (a sign-in, a pull request, a picker or page). Ask the user to complete it in the Runbooks window."

interface Presence {
  type: string
  element: { current: HTMLElement | null } | undefined
}

export interface AgentSessionInfo {
  runbook?: string | undefined
  runbookPath?: string | undefined
  sessionName?: string | undefined
  sessionId?: string | undefined
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Answers the app's MCP server (electron/main/agent/) from the runbook's live
 * state. Blocks register what an agent may see and do (useAgentBlock), and
 * every request acts through them, so what an agent does shows in the window.
 * Shows that an agent is connected, and, when the user asked for it, asks the
 * user before each run an agent starts.
 */
export function AgentBridgeProvider({
  session,
  children,
}: {
  session: AgentSessionInfo
  children?: ReactNode
}) {
  const api = useApi()
  const blocksRef = useRef(new Map<string, AgentBlockAdapter>())
  const presenceRef = useRef(new Map<string, Presence>())
  // The ids as the runbook writes them, by normalized id
  const writtenIdsRef = useRef(new Map<string, string>())
  const outputsRef = useRef<(() => Record<string, Record<string, string>>) | null>(null)
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const [status, setStatus] = useState<AgentServerStatus | null>(null)
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])
  const [lastActivity, setLastActivity] = useState<number | null>(null)
  const [lastAction, setLastAction] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [confirm, setConfirm] = useState<{
    blockId: string
    resolve: (ok: boolean) => void
  } | null>(null)

  useEffect(() => {
    api
      .invoke("agent:status")
      .then(setStatus)
      .catch(() => {})
    const offStatus = api.on("agent:status-changed", setStatus)
    const offActivity = api.on("agent:activity", () => {
      const t = Date.now()
      setLastActivity(t)
      setNow(t)
    })
    return () => {
      offStatus()
      offActivity()
    }
  }, [api])

  // Let the indicator lapse once the agent has gone quiet
  useEffect(() => {
    if (lastActivity === null) return
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [lastActivity])

  const registerBlock = useCallback((id: string, adapter: AgentBlockAdapter) => {
    const key = normalizeBlockId(id)
    writtenIdsRef.current.set(key, id)
    blocksRef.current.set(key, adapter)
    return () => {
      if (blocksRef.current.get(key) === adapter) blocksRef.current.delete(key)
    }
  }, [])

  const registerPresence = useCallback((id: string, type: string, element: Presence["element"]) => {
    const key = normalizeBlockId(id)
    const presence = { type, element }
    writtenIdsRef.current.set(key, id)
    presenceRef.current.set(key, presence)
    return () => {
      if (presenceRef.current.get(key) === presence) presenceRef.current.delete(key)
    }
  }, [])

  const registerOutputs = useCallback((read: () => Record<string, Record<string, string>>) => {
    outputsRef.current = read
    return () => {
      if (outputsRef.current === read) outputsRef.current = null
    }
  }, [])

  // Each request acts on the blocks as they are when it arrives
  useEffect(() => {
    const blockIds = (): string[] => {
      const ids = [...presenceRef.current.keys()]
      for (const id of blocksRef.current.keys()) if (!presenceRef.current.has(id)) ids.push(id)
      const position = (id: string) => presenceRef.current.get(id)?.element?.current ?? null
      return ids.sort((a, b) => {
        const ea = position(a)
        const eb = position(b)
        if (!ea || !eb) return 0
        return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      })
    }

    const summary = (key: string): AgentBlockSummary => {
      const adapter = blocksRef.current.get(key)
      const presence = presenceRef.current.get(key)
      const id = writtenIdsRef.current.get(key) ?? key
      if (!adapter) {
        return {
          id,
          type: presence?.type ?? "unknown",
          status: "not_controllable",
          blockedBy: [],
          controllable: false,
        }
      }
      return {
        id,
        type: adapter.type,
        title: adapter.title,
        status: adapter.status(),
        blockedBy: adapter.blockedBy(),
        controllable: adapter.run !== undefined || adapter.setInputs !== undefined,
      }
    }

    const find = (blockId: string): string => {
      const key = normalizeBlockId(blockId)
      if (blocksRef.current.has(key) || presenceRef.current.has(key)) return key
      throw new Error(
        `No block "${blockId}" on the page. Blocks: ${
          blockIds()
            .map((k) => writtenIdsRef.current.get(k) ?? k)
            .join(", ") || "(none)"
        }. A block in a collapsed chapter may not be on the page.`,
      )
    }

    const reveal = (key: string) => {
      presenceRef.current
        .get(key)
        ?.element?.current?.scrollIntoView?.({ behavior: "smooth", block: "center" })
    }

    const askUser = (blockId: string) =>
      new Promise<boolean>((resolve) => {
        setConfirm({ blockId, resolve })
      })

    const handle = async (request: AgentRequest): Promise<unknown> => {
      switch (request.op) {
        case "get_session": {
          const s = sessionRef.current
          const result: AgentSession = {
            open: s.sessionName !== undefined,
            runbook: s.runbook,
            runbookPath: s.runbookPath,
            sessionName: s.sessionName,
            sessionId: s.sessionId,
            blocks: blockIds().map(summary),
          }
          return result
        }
        case "get_block": {
          const key = find(request.blockId)
          const adapter = blocksRef.current.get(key)
          const detail: AgentBlockDetail = {
            ...summary(key),
            ...(adapter
              ? adapter.detail(request.logOffset ?? 0, request.logLimit ?? 200)
              : { note: NOT_CONTROLLABLE_NOTE }),
          }
          return detail
        }
        case "set_inputs": {
          const key = find(request.blockId)
          const adapter = blocksRef.current.get(key)
          if (!adapter?.setInputs)
            throw new Error(`Block "${request.blockId}" has no form to fill in.`)
          reveal(key)
          setLastAction(`Filled in ${request.blockId}`)
          return adapter.setInputs(request.values)
        }
        case "run_block": {
          const key = find(request.blockId)
          const adapter = blocksRef.current.get(key)
          if (!adapter?.run) return { started: false, reason: NOT_CONTROLLABLE_NOTE }
          const blocked = adapter.blockedBy()
          if (blocked.length > 0) return { started: false, reason: blocked.join("; ") }
          reveal(key)
          if (
            adapter.runIsAction !== false &&
            statusRef.current?.confirmRuns !== false &&
            !(await askUser(request.blockId))
          ) {
            return { started: false, reason: "The user declined the run in the Runbooks window." }
          }
          const before = adapter.status()
          const result = adapter.run()
          if (!result.started) return result
          setLastAction(`Ran ${request.blockId}`)
          // Answer once the window shows the run, so wait_for_block sees it running
          const deadline = Date.now() + RUN_START_WAIT_MS
          while (Date.now() < deadline) {
            const current = adapter.status()
            if (current === "running" || current !== before) break
            await sleep(50)
          }
          return result
        }
        case "cancel_block": {
          const key = find(request.blockId)
          const adapter = blocksRef.current.get(key)
          const cancelled = adapter?.cancel?.() ?? false
          if (cancelled) setLastAction(`Stopped ${request.blockId}`)
          return { cancelled }
        }
        case "get_outputs":
          return outputsRef.current?.() ?? {}
        default:
          throw new Error("Unknown request")
      }
    }

    return api.on("agent:request", ({ requestId, request }) => {
      handle(request)
        .then((result) => api.invoke("agent:respond", { requestId, ok: true, result }))
        .catch((err: unknown) =>
          api.invoke("agent:respond", {
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        .catch(() => {})
    })
  }, [api])

  const value = useMemo(
    (): AgentBridgeContextType => ({ registerBlock, registerPresence, registerOutputs }),
    [registerBlock, registerPresence, registerOutputs],
  )

  const active =
    status?.enabled === true && lastActivity !== null && now - lastActivity < ACTIVE_FOR_MS

  const answer = (ok: boolean) => {
    confirm?.resolve(ok)
    setConfirm(null)
  }

  return (
    <AgentBridgeContext.Provider value={value}>
      {children}
      {active && (
        <div
          data-testid="agent-indicator"
          role="status"
          className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-info/40 bg-info-muted px-3 py-1.5 text-sm shadow-md"
        >
          <Bot className="size-4 text-info" />
          <span>AI agent connected{lastAction ? ` · ${lastAction}` : ""}</span>
          <button
            type="button"
            className="ml-1 rounded p-0.5 hover:bg-accent cursor-pointer"
            title="Turn off AI agent access"
            onClick={() => {
              api
                .invoke("agent:update", { enabled: false })
                .then(setStatus)
                .catch(() => {})
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) answer(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let the AI agent run “{confirm?.blockId}”?</AlertDialogTitle>
            <AlertDialogDescription>
              An AI agent connected to Runbooks wants to run this block. Its script runs on this
              machine with your credentials and can change real infrastructure.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Don't run</AlertDialogCancel>
            <AlertDialogAction data-testid="agent-confirm-run" onClick={() => answer(true)}>
              Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AgentBridgeContext.Provider>
  )
}
