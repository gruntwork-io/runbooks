import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRunbookContext, useTemplateContext } from "@/contexts/useRunbook"
import { parsePageMessage } from "../protocol"
import {
  EMBED_PAGE_MESSAGE_CHANNEL,
  EMBED_RUNBOOK_MESSAGE_CHANNEL,
  INPUTS_MESSAGE,
} from "../../../../../../electron/shared/embed-messaging.ts"
import { errorMessage } from "../../../../../../src/errors/message"

/** The parts of Electron's `<webview>` element (WebviewTag) the block uses. */
export interface EmbedWebview extends HTMLElement {
  /** The guest's URL. Throws until the guest exists. */
  getURL(): string
  /** Send a message to the guest's preload. */
  send(channel: string, ...args: unknown[]): Promise<void>
}

/** A webview's `ipc-message` event: what the guest's preload sent with sendToHost. */
type IpcMessageEvent = Event & { channel: string; args: unknown[] }

interface FrameMessagingOptions {
  /** The block's `<webview>`, while it is mounted. */
  webview: EmbedWebview | null
  /**
   * Origin of the page from the runbook's assets folder that the webview shows.
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
 * Exchanges values with a page embedded from the runbook's assets folder over
 * the protocol in ../protocol.ts: the page's outputs become the block's
 * outputs, and the page receives the values of the `inputsId` Inputs blocks
 * when it loads, whenever they change, and whenever it asks for them.
 *
 * The page's guest relays the messages (electron/preload/embed-relay.ts), and
 * only those the page itself posted, not a frame inside it. They are
 * accepted, and inputs sent, only while the guest shows a page from
 * `pageOrigin`, which the main process keeps a local page's guest on.
 */
export function useFrameMessaging({
  webview,
  pageOrigin,
  id,
  outputNames,
  inputsId,
}: FrameMessagingOptions) {
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
    if (!webview || pageOrigin === undefined || inputs === undefined) return
    // Before its guest exists, the webview has no page to send to. Its
    // dom-ready sends the inputs once the page is there.
    if (!showsPage(webview, pageOrigin)) return
    const send = async () => {
      await webview.send(EMBED_RUNBOOK_MESSAGE_CHANNEL, { type: INPUTS_MESSAGE, inputs })
    }
    send().catch((error: unknown) => {
      setMessageError(`Couldn't send inputs to the page: ${errorMessage(error)}`)
    })
  }, [webview, pageOrigin, inputs])

  useEffect(() => {
    sendInputs()
  }, [sendInputs])

  useEffect(() => {
    if (!webview || pageOrigin === undefined) return
    const onIpcMessage = (event: Event) => {
      const { channel, args } = event as IpcMessageEvent
      if (channel !== EMBED_PAGE_MESSAGE_CHANNEL || !showsPage(webview, pageOrigin)) return
      const message = parsePageMessage(args[0], declaredOutputs)
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
    webview.addEventListener("ipc-message", onIpcMessage)
    // Each page the guest loads gets the inputs once it has loaded, by when
    // its preload listens for them.
    webview.addEventListener("dom-ready", sendInputs)
    return () => {
      webview.removeEventListener("ipc-message", onIpcMessage)
      webview.removeEventListener("dom-ready", sendInputs)
    }
  }, [webview, pageOrigin, declaredOutputs, id, registerOutputs, sendInputs])

  return { outputs, messageError }
}

/** Whether `webview`'s guest shows a page under `origin`. False before the guest exists. */
function showsPage(webview: EmbedWebview, origin: string): boolean {
  try {
    return webview.getURL().startsWith(`${origin}/`)
  } catch {
    return false
  }
}
