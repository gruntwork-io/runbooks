/**
 * Preload of the `<webview>` guests that show a page from the runbook's
 * assets folder. main/embeds.ts gives it to those guests only: external
 * pages get no preload.
 */
import { ipcRenderer } from "electron"
import { installEmbedRelay } from "./embed-relay.ts"

installEmbedRelay(window, ipcRenderer)
