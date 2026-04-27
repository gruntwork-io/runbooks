// Helpers for detecting the Wails desktop runtime and talking to its
// IPC services. The browser-served "gruntbooks open" UI should never
// import from ./wails; it's strictly for the Wails window path.

interface WailsGlobal {
  /**
   * environment is injected by the native Wails bridge at window init
   * (OS, Arch, Debug). It is NOT set by the `@wailsio/runtime` JS
   * module — that module's side-effect initialiser only creates an
   * empty `window._wails` object — so this is the reliable discriminator
   * between "real Wails webview" and "plain browser that happens to
   * have imported the runtime for its bindings".
   */
  environment?: { OS?: string; Arch?: string; Debug?: boolean }
  flags?: Record<string, unknown>
}

interface WailsWindow {
  _wails?: WailsGlobal
}

/**
 * isDesktop returns true when the frontend is running inside the
 * Wails desktop shell (as opposed to a regular browser opened via
 * `gruntbooks open`).
 *
 * We intentionally do NOT just check `'_wails' in window`: the
 * `@wailsio/runtime` module installs that key as an import-time side
 * effect even in plain browsers, so any page that includes the
 * bindings bundle would falsely report as desktop. `_wails.environment`
 * is only ever populated by the native bridge.
 */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false
  const wails = (window as unknown as WailsWindow)._wails
  return !!wails?.environment
}

/**
 * readWailsFlag reads a value from the Wails Options.Flags map. Used
 * to pick up things like the initial gruntbook path without a round-
 * trip through IPC. Returns undefined if the flag is absent or we're
 * not inside a Wails window.
 */
export function readWailsFlag<T = unknown>(name: string): T | undefined {
  if (!isDesktop()) return undefined
  const wails = (window as unknown as WailsWindow)._wails
  return wails?.flags?.[name] as T | undefined
}

/**
 * isMacOSDesktop returns true only when running inside the Wails desktop
 * shell on macOS. Used to conditionally pad the header left edge to clear
 * the inset traffic-light buttons (added by MacTitleBarHiddenInsetUnified)
 * and to enable the `--wails-draggable: drag` CSS region.
 */
export function isMacOSDesktop(): boolean {
  if (!isDesktop()) return false
  const wails = (window as unknown as WailsWindow)._wails
  return wails?.environment?.OS === 'darwin'
}
