import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useRunbookContext, useTemplateContext } from "@/contexts/useRunbook"
import { INPUTS_MESSAGE, parsePageMessage } from "../protocol"

interface FrameMessagingOptions {
  frameRef: RefObject<HTMLIFrameElement | null>
  /**
   * Origin of the page from the runbook's assets folder that the frame shows.
   * Undefined for an external page or an invalid block, which exchange no messages.
   */
  pageOrigin: string | undefined
  /** Block id the page's outputs are registered under. Set whenever `outputNames` is not empty. */
  id: string | undefined
  /** Output names the page may set. */
  outputNames: readonly string[]
  /** Inputs blocks whose values the page receives. */
  inputsId: string | string[] | undefined
}

/**
 * Exchanges values with a page framed from the runbook's assets folder over
 * the protocol in ../protocol.ts: the page's outputs become the block's
 * outputs, and the page receives the values of the `inputsId` Inputs blocks
 * when it loads, whenever they change, and whenever it asks for them.
 *
 * Only messages from this block's own frame, while it shows a page from
 * `pageOrigin`, are accepted, and inputs are only delivered to that origin. A
 * frame that navigated to another site neither sends nor receives.
 */
export function useFrameMessaging({ frameRef, pageOrigin, id, outputNames, inputsId }: FrameMessagingOptions) {
  const { registerOutputs } = useRunbookContext()
  const templateCtx = useTemplateContext(inputsId)
  const [outputs, setOutputs] = useState<Record<string, string> | null>(null)
  const [messageError, setMessageError] = useState<string | null>(null)
  const outputsRef = useRef<Record<string, string>>({})

  // MDX passes a new array on every render, so key the set on its contents.
  const outputNamesKey = outputNames.join("\n")
  const declaredOutputs = useMemo(
    () => new Set(outputNamesKey === "" ? [] : outputNamesKey.split("\n")),
    [outputNamesKey],
  )
  const inputs = inputsId ? templateCtx.inputs : undefined

  const sendInputs = useCallback(() => {
    if (pageOrigin === undefined || inputs === undefined) return
    try {
      // A frame still showing about:blank, or one that navigated away, has
      // another origin, and the browser drops the message.
      frameRef.current?.contentWindow?.postMessage({ type: INPUTS_MESSAGE, inputs }, pageOrigin)
    } catch (error) {
      setMessageError(`Couldn't send inputs to the page: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [pageOrigin, inputs, frameRef])

  useEffect(() => {
    sendInputs()
  }, [sendInputs])

  useEffect(() => {
    if (pageOrigin === undefined) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== pageOrigin) return
      const message = parsePageMessage(event.data, declaredOutputs)
      if (!message) return
      switch (message.kind) {
        case "get-inputs":
          sendInputs()
          return
        case "invalid":
          setMessageError(message.error)
          return
        case "set-outputs": {
          if (!id) {
            setMessageError("The page set outputs, but the block's outputs prop lists none.")
            return
          }
          const merged = { ...outputsRef.current, ...message.outputs }
          outputsRef.current = merged
          setOutputs(merged)
          setMessageError(null)
          registerOutputs(id, merged)
          return
        }
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [pageOrigin, frameRef, declaredOutputs, id, registerOutputs, sendInputs])

  return { outputs, messageError, onFrameLoad: sendInputs }
}
