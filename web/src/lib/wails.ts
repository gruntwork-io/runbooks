// Helpers for detecting the Wails desktop runtime and talking to its
// IPC services. The browser-served "gruntbooks open" UI should never
// import from ./wails; it's strictly for the Wails window path.

interface WailsRuntimeFlags {
  /** Present only when running inside the Wails webview. */
  'wails.flags'?: Record<string, unknown>;
}

/**
 * isDesktop returns true when the frontend is running inside the
 * Wails desktop shell (as opposed to a regular browser opened via
 * `gruntbooks open`). The check looks for the runtime global that
 * @wailsio/runtime installs at boot.
 */
export function isDesktop(): boolean {
  // @wailsio/runtime exposes _wails on window once the JS runtime
  // loads. Using a duck-typed check avoids pulling in the runtime
  // module just to compute a boolean.
  return typeof window !== 'undefined' && '_wails' in window;
}

/**
 * readWailsFlag reads a value from the Wails Options.Flags map. Used
 * to pick up things like the initial gruntbook path without a round-
 * trip through IPC. Returns undefined if the flag is absent or the
 * runtime isn't loaded.
 */
export function readWailsFlag<T = unknown>(name: string): T | undefined {
  if (!isDesktop()) return undefined;
  const flags = (window as unknown as WailsRuntimeFlags)['wails.flags'];
  return flags?.[name] as T | undefined;
}
