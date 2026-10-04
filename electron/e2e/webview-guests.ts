/**
 * Reach the pages the Iframe block embeds. Each runs in a `<webview>` guest,
 * a web contents of its own that Playwright doesn't list as a page or frame,
 * so these go through the main process.
 */
import { expect, type ElectronApplication } from "@playwright/test"
import { readFromMain } from "./main-process.ts"

/** The URLs of the <webview> guests. */
export function guestUrls(app: ElectronApplication): Promise<string[]> {
  return readFromMain(
    app,
    ({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((c) => c.getType() === "webview")
        .map((c) => c.getURL()),
    undefined,
  )
}

/**
 * Run `script` in the guest whose URL matches `url`, once there is one, and
 * return its result. A lost result runs `script` again, so it has to be safe
 * to repeat.
 */
export async function inGuest<T>(
  app: ElectronApplication,
  url: RegExp,
  script: string,
): Promise<T> {
  await expect.poll(async () => (await guestUrls(app)).some((u) => url.test(u))).toBe(true)
  return (await readFromMain(
    app,
    ({ webContents }, { source, code }) => {
      const pattern = new RegExp(source)
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === "webview" && pattern.test(c.getURL()))!
      return guest.executeJavaScript(code)
    },
    { source: url.source, code: script },
  )) as T
}
