/**
 * Saved sessions, end to end: the app keeps each session in the sessions
 * database in its user data folder (v0/sessions/db/sessions.db,
 * packages/app-main/src/engine.ts), encrypted with Electron's safeStorage
 * (packages/app-main/src/sessionCipher.ts), and resumes it when it opens
 * the runbook again.
 *
 * Every launch passes --use-mock-keychain (fixtures.ts), so on macOS each
 * launch has the mock Keychain's key, the same one. Linux CI has no secret
 * service, so safeStorage has only the key Chromium hardcodes, which the
 * app takes only when RUNBOOKS_TEST_INSECURE_SESSION_KEY=1 asks.
 *
 * The window does not say yet that a session was resumed, or what it could
 * not restore: today's SessionResumedNotice comes with phase 5's sessions
 * package, and today's electron/e2e/sessions.spec.ts with it.
 *
 * Runs against the build in app-out/: `just app-build` builds it first.
 */
import fs from "node:fs"
import path from "node:path"
import { expect, test, trust } from "./fixtures.ts"

/** Inputs' test runbook: `config` is a form whose required Name starts empty. */
const RUNBOOK = path.join(import.meta.dirname, "..", "blocks", "inputs", "testdata", "end-to-end")

/** Lets Linux's hardcoded key encrypt, where there is no secret service. Other platforms ignore it. */
const INSECURE_KEY = { RUNBOOKS_TEST_INSECURE_SESSION_KEY: "1" }

test.describe("Saved sessions", () => {
  test("a value typed into a trusted runbook's form is back once the app closes and opens it again", async ({
    launch,
  }) => {
    const first = await launch({ args: [RUNBOOK], env: INSECURE_KEY })
    await trust(first.page)
    const typed = first.page.locator("#runbook-block-config")
    await typed.getByRole("textbox", { name: "Name" }).fill("web")
    // Ready once the engine has the required Name, which it saves as it takes it.
    await expect(typed.locator(".block-status")).toHaveText("Ready")
    await first.app.close()

    const { page } = await launch({ args: [RUNBOOK], env: INSECURE_KEY })
    const config = page.locator("#runbook-block-config")
    await expect(config.getByRole("textbox", { name: "Name" })).toHaveValue("web")
    await expect(config.locator(".block-status")).toHaveText("Ready")
    // Trusted, as it was left: no prompt.
    await expect(page.getByRole("region", { name: "Trust this runbook" })).toHaveCount(0)
  })

  test("a sessions.db the app cannot use: the runbook still opens and runs, main's output names the file, and it is left as it was", async ({
    launch,
    userDataDir,
  }) => {
    const file = path.join(userDataDir, "v0", "sessions", "db", "sessions.db")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const garbage = "not a database\n".repeat(512)
    fs.writeFileSync(file, garbage)

    const { app, page, output } = await launch({ args: [RUNBOOK] })
    await trust(page)
    const config = page.locator("#runbook-block-config")
    await config.getByRole("textbox", { name: "Name" }).fill("web")
    await config.getByRole("button", { name: "Submit" }).click()
    await expect(config.locator(".block-status")).toHaveText("Done")
    const deploy = page.locator("#runbook-block-deploy")
    await deploy.getByRole("button", { name: "Run" }).click()
    await expect(deploy.locator(".block-status")).toHaveText("Done")
    expect(output()).toContain(
      `The sessions database ${file} cannot be used, so sessions are not kept after this run`,
    )
    await app.close()
    expect(fs.readFileSync(file, "utf8")).toBe(garbage)
  })
})
