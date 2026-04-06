/**
 * Centralized logger for the Electron main process.
 *
 * In development mode all levels are emitted. In production only warn and
 * error are emitted — debug and info are no-ops.
 */

const isDev = !!process.env.ELECTRON_RENDERER_URL

function noop(..._args: unknown[]): void {}

function makeLogger(tag: string) {
  const prefix = `[${tag}]`
  return {
    debug: isDev ? (...args: unknown[]) => console.debug(prefix, ...args) : noop,
    info:  isDev ? (...args: unknown[]) => console.log(prefix, ...args)   : noop,
    warn:  (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  }
}

export { makeLogger }
