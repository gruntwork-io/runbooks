/**
 * Strip Electron's IPC wrapper from a rejected invoke message.
 *
 * The implementation lives in electron/shared/ipc-error-message.ts so the
 * preload (which cleans every `api.invoke` rejection) and the renderer use one
 * copy. Renderer callers that clean again are harmless, since the function is
 * idempotent, and it keeps tests that mock `api` with Electron's raw
 * "Error invoking remote method '<channel>': Error: <message>" text working.
 */
export { cleanIpcErrorMessage } from "../../../electron/shared/ipc-error-message"
