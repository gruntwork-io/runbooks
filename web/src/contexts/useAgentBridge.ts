import { useContext, useEffect, useRef, useState, type RefObject } from "react"
import { AgentBridgeContext, type AgentBlockAdapter } from "./AgentBridgeContext.types"

/**
 * Let AI agents see and act on block `id` through `adapter`, built on every
 * render from the block's current state. Nothing happens outside an
 * AgentBridgeProvider, or when `id` is empty.
 */
export function useAgentBlock(id: string, adapter: AgentBlockAdapter): void {
  const bridge = useContext(AgentBridgeContext)
  const adapterRef = useRef(adapter)
  useEffect(() => {
    adapterRef.current = adapter
  })
  const type = adapter.type
  const registerBlock = bridge?.registerBlock
  useEffect(() => {
    if (!registerBlock || !id) return
    // A stable stand-in that always reads the latest adapter
    const current = () => adapterRef.current
    return registerBlock(id, {
      type,
      get title() {
        return current().title
      },
      get runIsAction() {
        return current().runIsAction
      },
      get canRun() {
        return current().run !== undefined
      },
      status: () => current().status(),
      blockedBy: () => current().blockedBy(),
      detail: (offset, limit) => current().detail(offset, limit),
      run: () =>
        current().run?.() ?? {
          started: false,
          reason: `This block has no single Run button. Use act_on_block with one of its actions: ${
            (current().actions?.() ?? []).map((a) => a.name).join(", ") || "(none)"
          }.`,
        },
      cancel: () => current().cancel?.() ?? false,
      readsForms: () => current().readsForms?.() ?? [],
      actions: () => current().actions?.() ?? [],
      act: (action, params) => {
        const act = current().act
        if (!act) return { ok: false, reason: `Block "${id}" has no actions.` }
        return act(action, params)
      },
      needsHuman: () => current().needsHuman?.(),
      setInputs: (values) => {
        const setInputs = current().setInputs
        if (!setInputs) throw new Error(`Block "${id}" has no form to fill in.`)
        return setInputs(values)
      },
    })
  }, [registerBlock, id, type])
}

/** Note block `id` on the page, so agents see it even when they can't control it. */
export function useAgentPresence(
  id: string,
  type: string,
  element: RefObject<HTMLElement | null> | undefined,
): void {
  const registerPresence = useContext(AgentBridgeContext)?.registerPresence
  useEffect(() => {
    if (!registerPresence || !id) return
    return registerPresence(id, type, element)
  }, [registerPresence, id, type, element])
}

/** Let get_outputs read every block's outputs through `read`. */
export function useAgentOutputs(read: () => Record<string, Record<string, string>>): void {
  const registerOutputs = useContext(AgentBridgeContext)?.registerOutputs
  const readRef = useRef(read)
  useEffect(() => {
    readRef.current = read
  })
  useEffect(() => {
    if (!registerOutputs) return
    return registerOutputs(() => readRef.current())
  }, [registerOutputs])
}

/**
 * Returns `defer(fn)`, which runs `fn` after the block's next render has
 * committed. For an agent action that sets a field and then presses the
 * button that reads it, as a person would in two steps: `fn` should reach
 * the button's handler through a ref that holds the latest render's handlers.
 */
export function useAgentDeferred(): (fn: () => void) => void {
  const queue = useRef<Array<() => void>>([])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (queue.current.length === 0) return
    const pending = queue.current
    queue.current = []
    for (const fn of pending) fn()
  }, [tick])
  return (fn) => {
    queue.current.push(fn)
    setTick((n) => n + 1)
  }
}

/** A ref that always holds `value` as of the latest committed render. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/** A string param of an agent action, or undefined. */
export function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}
