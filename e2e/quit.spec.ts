/**
 * Quitting the rebuilt app while a script runs, as a user would: the script
 * is stopped with SIGTERM and has its grace to clean up before the app
 * exits. The page drives the engine over IPC, as the window will.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

/** The preload's bridge, as the page holds it. */
interface Bridge {
  readonly send: (message: string) => void
  readonly onMessage: (listener: (message: string) => void) => () => void
}

/** Calls `tag` through the page's bridge, raw, and returns the encoded exit. */
function call(page: Page, id: string, tag: string, payload: unknown): Promise<unknown> {
  return page.evaluate(
    (request) =>
      new Promise((resolve) => {
        const bridge = Reflect.get(window, "engine") as Bridge
        const stop = bridge.onMessage((text) => {
          const message = JSON.parse(text)
          if (message._tag !== "Exit" || message.requestId !== request.id) return
          stop()
          resolve(message.exit)
        })
        bridge.send(JSON.stringify(request))
      }),
    { _tag: "Request", id, tag, payload, headers: [] },
  )
}

/**
 * A script that writes `started`, runs until stopped, and on SIGTERM takes
 * a second to clean up before it writes `stopped`.
 */
const TRAPS_TERM = `#!/usr/bin/env bash
trap 'sleep 1; echo stopped > "$QUIT_PROBE/stopped"; exit 0' TERM
echo started > "$QUIT_PROBE/started"
while :; do sleep 0.2; done
`

let folder: string
test.beforeEach(() => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-app-quit-")))
})
test.afterEach(() => fs.rmSync(folder, { recursive: true, force: true }))

test.describe("quitting the rebuilt app", () => {
  test("gives a running script its grace to clean up before the app exits", async ({ launch }) => {
    const runbook = path.join(folder, "runbook")
    const probe = path.join(folder, "probe")
    fs.mkdirSync(runbook)
    fs.mkdirSync(probe)
    fs.writeFileSync(path.join(runbook, "runbook.mdx"), '<Command id="trap" path="trap.sh" />\n')
    fs.writeFileSync(path.join(runbook, "trap.sh"), TRAPS_TERM, { mode: 0o755 })

    const { app, page } = await launch({ env: { QUIT_PROBE: probe } })
    const opened = (await call(page, "open", "OpenSession", {
      path: path.join(runbook, "runbook.mdx"),
    })) as { value: { _tag: string; session: { session: string; trust: { hash: string } } } }
    expect(opened.value._tag).toBe("Opened")
    const { session, trust } = opened.value.session
    await call(page, "trust", "TrustSession", { session, hash: trust.hash })
    await call(page, "run", "RunBlock", { session, block: "trap" })
    await expect.poll(() => fs.existsSync(path.join(probe, "started"))).toBe(true)

    await app.close()
    expect(fs.readdirSync(probe).sort()).toEqual(["started", "stopped"])
  })
})
