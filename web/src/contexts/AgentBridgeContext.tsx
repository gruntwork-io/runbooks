import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Bot, X } from "lucide-react"
import { useApi } from "./ApiContext"
import { useRevealElement } from "./useRunbookChapters"
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
import {
  AGENT_APPROVAL_TIMEOUT_MS,
  type AgentActResult,
  type AgentBlockDetail,
  type AgentBlockSummary,
  type AgentFormReview,
  type AgentInputVariable,
  type AgentRequest,
  type AgentRunResult,
  type AgentServerStatus,
  type AgentSession,
} from "../../../src/domain/agent/protocol"

/** How long after an agent's last request the window still says one is connected. */
const ACTIVE_FOR_MS = 2 * 60 * 1000
/** How long run_block waits to see the run start before it answers. */
const RUN_START_WAIT_MS = 3000

/** What the user has to do for a block an agent can't control. */
const NOT_CONTROLLABLE_NOTE =
  "This block registered no agent controls, so an agent can't act on it. Ask the user to complete it in the Runbooks window."

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
  // The fields (by form, normalized) the agent set or confirmed. A field
  // nobody touched, default included, is unreviewed. Per session.
  const reviewedRef = useRef(new Map<string, Set<string>>())
  useEffect(() => {
    reviewedRef.current = new Map()
  }, [session.sessionId])
  // run_block requests run one at a time: each waits until the run before it
  // shows in the window, so its blockers (exclusive, dependsOn) see that run
  const runQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const revealElement = useRevealElement()
  const revealRef = useRef(revealElement)
  useEffect(() => {
    revealRef.current = revealElement
  })

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
    /** What the agent wants to do, when it isn't running the block. */
    action?: string | undefined
    resolve: (ok: boolean) => void
  } | null>(null)
  const confirmRef = useRef(confirm)
  useEffect(() => {
    confirmRef.current = confirm
  }, [confirm])
  // An approval still open when the provider goes away is a no
  useEffect(() => () => confirmRef.current?.resolve(false), [])
  // A new status from main. Turning access off declines an approval that is still open.
  const applyStatus = useCallback((next: AgentServerStatus) => {
    statusRef.current = next
    setStatus(next)
    if (!next.enabled) confirmRef.current?.resolve(false)
  }, [])

  useEffect(() => {
    api
      .invoke("agent:status")
      .then(applyStatus)
      .catch(() => {})
    const offStatus = api.on("agent:status-changed", applyStatus)
    const offActivity = api.on("agent:activity", () => {
      const t = Date.now()
      setLastActivity(t)
      setNow(t)
    })
    return () => {
      offStatus()
      offActivity()
    }
  }, [api, applyStatus])

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
      const fields = formFields(key)
      return {
        id,
        type: adapter.type,
        title: adapter.title,
        status: adapter.status(),
        blockedBy: adapter.blockedBy(),
        controllable: true,
        ...(fields && unreviewed(key, fields).length > 0 ? { needsReview: true } : {}),
        ...(adapter.needsHuman?.() ? { needsHuman: adapter.needsHuman() } : {}),
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

    // Shows the block's chapter if it is hidden, and scrolls the block into view
    const reveal = (key: string) => {
      const element = presenceRef.current.get(key)?.element?.current
      if (element) revealRef.current(element)
    }

    /** A form's fields, with whether the agent reviewed each; undefined for a block without a form. */
    function formFields(key: string): AgentInputVariable[] | undefined {
      const inputs = blocksRef.current.get(key)?.detail(0, 0).inputs
      if (!inputs) return undefined
      const reviewed = reviewedRef.current.get(key)
      return inputs.map((field) => ({
        ...field,
        reviewed: field.readOnly || reviewed?.has(field.name) === true,
      }))
    }

    function unreviewed(_key: string, fields: AgentInputVariable[]): string[] {
      return fields.filter((field) => !field.reviewed).map((field) => field.name)
    }

    const markReviewed = (key: string, names: Iterable<string>) => {
      const set = reviewedRef.current.get(key) ?? new Set<string>()
      for (const name of names) set.add(name)
      reviewedRef.current.set(key, set)
    }

    /**
     * The first form block `key` reads (itself, for a form; following each
     * form's imports) with fields the agent hasn't set or confirmed.
     */
    const reviewNeeded = (key: string): AgentFormReview | undefined => {
      const seen = new Set<string>()
      const order: string[] = []
      const visit = (k: string) => {
        if (seen.has(k)) return
        seen.add(k)
        for (const id of blocksRef.current.get(k)?.readsForms?.() ?? []) visit(normalizeBlockId(id))
        order.push(k)
      }
      visit(key)
      for (const formKey of order) {
        const fields = formFields(formKey)
        if (!fields) continue
        const pending = unreviewed(formKey, fields)
        if (pending.length === 0) continue
        const form = writtenIdsRef.current.get(formKey) ?? formKey
        const target = writtenIdsRef.current.get(key) ?? key
        return {
          form,
          type: blocksRef.current.get(formKey)?.type ?? "Inputs",
          fields,
          unreviewed: pending,
          message:
            `Review form "${form}" before ${formKey === key ? "it is used" : `"${target}" runs`}: ` +
            "its values, defaults included, haven't been set or confirmed by you. Defaults count as unreviewed. " +
            "Read each field's description, then call set_inputs with the values to use, or confirm_inputs to accept them as shown.",
        }
      }
      return undefined
    }

    // Declined if the user doesn't answer in time, so an approval can't start
    // a run after the server has given up on the request
    const askUser = (blockId: string, action?: string) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (ok: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          setConfirm((current) => (current?.resolve === settle ? null : current))
          resolve(ok)
        }
        const timer = setTimeout(() => settle(false), AGENT_APPROVAL_TIMEOUT_MS)
        setConfirm({ blockId, action, resolve: settle })
      })

    const actOnBlock = async (
      blockId: string,
      action: string,
      params: Record<string, unknown>,
    ): Promise<AgentActResult & { block?: AgentBlockSummary }> => {
      const key = find(blockId)
      const adapter = blocksRef.current.get(key)
      if (!adapter?.act) return { ok: false, reason: NOT_CONTROLLABLE_NOTE }
      const actions = adapter.actions?.() ?? []
      const spec = actions.find((a) => a.name === action)
      if (!spec) {
        return {
          ok: false,
          reason: `Block "${blockId}" has no action "${action}". Its actions: ${
            actions.map((a) => a.name).join(", ") || "(none)"
          }.`,
        }
      }
      if (spec.unavailable) return { ok: false, reason: spec.unavailable }
      const missing = Object.entries(spec.params ?? {})
        .filter(
          ([name, param]) => param.required && (params[name] === undefined || params[name] === ""),
        )
        .map(([name]) => name)
      if (missing.length > 0) return { ok: false, reason: `Missing params: ${missing.join(", ")}` }
      if (spec.changes) {
        const review = reviewNeeded(key)
        if (review) return { ok: false, reason: review.message }
      }
      reveal(key)
      if (
        spec.changes &&
        statusRef.current?.confirmRuns !== false &&
        !(await askUser(blockId, spec.description))
      ) {
        return { ok: false, reason: "The user declined in the Runbooks window, or didn't answer." }
      }
      if (statusRef.current?.enabled !== true) {
        return { ok: false, reason: "AI agent access was turned off in the Runbooks window." }
      }
      const before = adapter.status()
      const result = await adapter.act(action, params)
      if (!result.ok) return result
      setLastAction(`${action} on ${blockId}`)
      // Answer once the window shows the change, so get_block sees it
      const deadline = Date.now() + RUN_START_WAIT_MS
      while (spec.changes && Date.now() < deadline && adapter.status() === before) await sleep(50)
      return { ...result, block: summary(key) }
    }

    const runBlock = async (blockId: string): Promise<AgentRunResult> => {
      const key = find(blockId)
      const adapter = blocksRef.current.get(key)
      if (!adapter?.run) return { started: false, reason: NOT_CONTROLLABLE_NOTE }
      const review = reviewNeeded(key)
      if (review) return { started: false, reason: review.message, needsReview: review }
      const blocked = adapter.blockedBy()
      if (blocked.length > 0) return { started: false, reason: blocked.join("; ") }
      reveal(key)
      if (
        adapter.runIsAction !== false &&
        statusRef.current?.confirmRuns !== false &&
        !(await askUser(blockId))
      ) {
        return {
          started: false,
          reason: "The user declined the run in the Runbooks window, or didn't answer.",
        }
      }
      // Access may have been turned off while the approval was open
      if (statusRef.current?.enabled !== true) {
        return { started: false, reason: "AI agent access was turned off in the Runbooks window." }
      }
      const before = adapter.status()
      const result = adapter.run()
      if (!result.started) return result
      setLastAction(`Ran ${blockId}`)
      // Answer once the window shows the run, so wait_for_block sees it running
      const deadline = Date.now() + RUN_START_WAIT_MS
      while (Date.now() < deadline) {
        const current = adapter.status()
        if (current === "running" || current !== before) break
        await sleep(50)
      }
      return result
    }

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
          const fields = formFields(key)
          const detail: AgentBlockDetail = {
            ...summary(key),
            ...(adapter
              ? adapter.detail(request.logOffset ?? 0, request.logLimit ?? 200)
              : { note: NOT_CONTROLLABLE_NOTE }),
            ...(fields ? { inputs: fields } : {}),
            ...(adapter?.actions && adapter.actions().length > 0
              ? { actions: adapter.actions() }
              : {}),
            sessionId: sessionRef.current.sessionId,
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
          const result = adapter.setInputs(request.values)
          markReviewed(
            key,
            Object.keys(request.values).filter((name) => !(name in result.rejected)),
          )
          const fields = formFields(key) ?? []
          return { ...result, unreviewed: unreviewed(key, fields) }
        }
        case "confirm_inputs": {
          const key = find(request.blockId)
          const fields = formFields(key)
          if (!fields) throw new Error(`Block "${request.blockId}" has no form to confirm.`)
          reveal(key)
          markReviewed(
            key,
            fields.map((field) => field.name),
          )
          setLastAction(`Confirmed ${request.blockId}`)
          return { confirmed: writtenIdsRef.current.get(key) ?? key, fields: formFields(key) ?? [] }
        }
        case "run_block": {
          const run = runQueueRef.current.then(() => runBlock(request.blockId))
          runQueueRef.current = run.catch(() => {})
          return run
        }
        case "act_on_block": {
          const act = runQueueRef.current.then(() =>
            actOnBlock(request.blockId, request.action, request.params),
          )
          runQueueRef.current = act.catch(() => {})
          return act
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
                .then(applyStatus)
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
            <AlertDialogTitle>
              {confirm?.action
                ? `Let the AI agent act on “${confirm.blockId}”?`
                : `Let the AI agent run “${confirm?.blockId}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action
                ? `An AI agent connected to Runbooks wants to: ${confirm.action} This uses your credentials and can change real things, such as a repository or a cloud account.`
                : "An AI agent connected to Runbooks wants to run this block. Its script runs on this machine with your credentials and can change real infrastructure."}
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
