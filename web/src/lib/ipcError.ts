/**
 * Strip Electron's IPC wrapper from a rejected invoke message so the renderer
 * can show the handler's actual message. Electron rejects with
 * "Error invoking remote method 'channel': Error: <message>"; we want just
 * "<message>".
 */
export function cleanIpcErrorMessage(raw: string): string {
  let msg = raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
  // Serialization can leave one or more leading "Error: " prefixes.
  while (/^Error:\s*/.test(msg)) {
    msg = msg.replace(/^Error:\s*/, '')
  }
  return msg.trim()
}
