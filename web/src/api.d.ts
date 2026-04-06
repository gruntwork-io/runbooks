import type { IpcChannelMap, IpcEventMap, InvokeChannel, EventChannel } from "../../electron/shared/channels.ts"

interface RunbooksAPI {
  invoke<C extends InvokeChannel>(channel: C, ...args: IpcChannelMap[C]["params"] extends void ? [] : [IpcChannelMap[C]["params"]]): Promise<IpcChannelMap[C]["result"]>
  on<C extends EventChannel>(channel: C, callback: (payload: IpcEventMap[C]) => void): () => void
  once<C extends EventChannel>(channel: C, callback: (payload: IpcEventMap[C]) => void): void
}

declare global {
  interface Window {
    api: RunbooksAPI
  }
}

export {}
