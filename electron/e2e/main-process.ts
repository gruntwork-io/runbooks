/**
 * Calls into the Electron main process that survive a lost result.
 *
 * Playwright evaluates with CDP's `awaitPromise`, and V8 holds the promise it
 * waits on only weakly until the promise's callbacks run. Right after launch
 * the main process is busy (the boilerplate WASM compiles in the background),
 * so a garbage collection can free that promise first. The call then fails
 * with "Resulting promise was garbage collected." even though the callback
 * already ran: Playwright calls it synchronously, before the wait. See
 * https://github.com/microsoft/playwright/issues/33737.
 */
import type { ElectronApplication } from "@playwright/test"

// Bounds readFromMain: each lost result needs a garbage collection to land in
// a sub-millisecond window, so a second failure in a row is already rare.
const MAX_READ_ATTEMPTS = 5

/**
 * Run a side effect in the main process, such as clicking a menu item or
 * resizing a window. A lost result is ignored, because the callback has
 * already run by then and returns nothing.
 */
export async function runInMain<Arg>(
  app: ElectronApplication,
  fn: Parameters<typeof app.evaluate<void, Arg>>[0],
  arg: Arg,
): Promise<void> {
  try {
    await app.evaluate(fn, arg)
  } catch (err) {
    if (!isLostResult(err)) throw err
  }
}

/**
 * Resize the app's only window. setSize sets Electron's logical window size,
 * which is the size the page's viewport (window.innerWidth/innerHeight) gets.
 * window.outerWidth/outerHeight can read larger, because they also count any
 * frame border drawn outside that size. Since Electron 43 a frameless window on
 * Linux has one: under Xvfb, with no shadow to draw, it is 4px on the left,
 * right and bottom, so a 900px-wide window reports an outerWidth of 908.
 */
export async function resizeMainWindow(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await runInMain(
    app,
    ({ BrowserWindow }, size) => {
      const [win] = BrowserWindow.getAllWindows()
      if (!win) throw new Error("no window to resize")
      win.setSize(size.width, size.height)
    },
    { width, height },
  )
}

/**
 * Read a value from the main process, retrying when the result is lost.
 * Only for callbacks that change nothing, since a retry runs them again.
 */
export async function readFromMain<R, Arg>(
  app: ElectronApplication,
  fn: Parameters<typeof app.evaluate<R, Arg>>[0],
  arg: Arg,
): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await app.evaluate(fn, arg)
    } catch (err) {
      if (!isLostResult(err) || attempt === MAX_READ_ATTEMPTS) throw err
    }
  }
}

function isLostResult(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Resulting promise was garbage collected")
}
