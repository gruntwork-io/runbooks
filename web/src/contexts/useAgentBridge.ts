import { useContext, useEffect, useRef, type RefObject } from "react"
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
      status: () => current().status(),
      blockedBy: () => current().blockedBy(),
      detail: (offset, limit) => current().detail(offset, limit),
      run: () =>
        current().run?.() ?? { started: false, reason: "This block can't be run by an agent." },
      cancel: () => current().cancel?.() ?? false,
      readsForms: () => current().readsForms?.() ?? [],
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
