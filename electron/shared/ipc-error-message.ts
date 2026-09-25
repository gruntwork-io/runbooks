/**
 * Strip Electron's IPC wrapper from a rejected invoke message so the renderer
 * can show the handler's actual message. Electron rejects with
 * "Error invoking remote method 'channel': Error: <message>"; we want just
 * "<message>".
 *
 * The preload applies this to every `api.invoke` rejection. MAIN's half of the
 * contract is toIpcError() (electron/main/ipc/ipc-error.ts), which makes sure
 * "<message>" is the real failure detail rather than a FiberFailure dump.
 */
export function cleanIpcErrorMessage(raw: string): string {
  let msg = raw.replace(/^Error invoking remote method '[^']*':\s*/, "")
  // Serialization can leave one or more leading "Error: " prefixes.
  while (/^Error:\s*/.test(msg)) {
    msg = msg.replace(/^Error:\s*/, "")
  }
  return msg.trim()
}
