/**
 * The window's preload. It runs sandboxed, before the page, and gives the
 * page the engine bridge (`bridge.ts`) as `window.engine`: a send and a
 * listener, over one IPC message per protocol message. The page gets no
 * `ipcRenderer`, no IPC event and nothing else of Electron's.
 *
 * electron-vite builds it as CommonJS (`app-out/preload/index.cjs`): a
 * sandboxed preload is a script, and may require only electron.
 */
import { contextBridge, ipcRenderer } from "electron"
import { BRIDGE, makeBridge } from "./bridge.ts"

contextBridge.exposeInMainWorld(BRIDGE, makeBridge(ipcRenderer))
