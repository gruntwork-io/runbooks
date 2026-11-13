/**
 * E2E test for the custom CA certificate setting (electron/main/custom-ca.ts).
 *
 * Through the real IPC, preload allowlist and Electron's own node:tls: the
 * Header menu opens the dialog, Choose File… trusts the fixture CA (the
 * native file dialog is stubbed in main to pick it), main's default CA list
 * and spawned processes' env get it, a relaunch keeps it, and the native
 * menu's item opens the dialog to remove it.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts custom-ca.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test"
import { X509Certificate } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { MOCK_KEYCHAIN } from "./launch.ts"
import { readFromMain, runInMain } from "./main-process.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")
const CA_FILE = path.join(ROOT, "test/fixtures/tls/ca.pem")
// The fixture CA as Node encodes it, which is how main installs it.
const CA_PEM = new X509Certificate(fs.readFileSync(CA_FILE)).toString().trim()
const CA_NAME = "Runbooks TLS Test Fixture CA"

let userDataDir: string

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      // initCustomCa reads userData before the app is ready.
      RUNBOOKS_TEST_USER_DATA_DIR: userDataDir,
      // Skip the login-shell env capture, and start without the CA vars,
      // whatever the machine's env has.
      TERM_PROGRAM: "e2e",
      SSL_CERT_FILE: "",
      GIT_SSL_CAINFO: "",
    },
  })
}

/** What main trusts and hands on: whether its default CA list has the fixture CA, and GIT_SSL_CAINFO. */
const mainTrust = (app: ElectronApplication) =>
  readFromMain(
    app,
    (_electron, pem) => {
      const tls = process.getBuiltinModule("node:tls")
      return {
        trusted: tls.getCACertificates("default").some((cert) => cert.trim() === pem),
        gitCaInfo: process.env.GIT_SSL_CAINFO ?? null,
      }
    },
    CA_PEM,
  )

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-custom-ca-e2e-"))
})

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test("trusts a custom CA chosen from the menu, keeps it across a relaunch, and removes it", async () => {
  const bundle = path.join(userDataDir, "custom-ca-bundle.pem")

  const app1 = await launch()
  try {
    const page = await app1.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    expect(await mainTrust(app1)).toEqual({ trusted: false, gitCaInfo: "" })

    // The native file dialog can't be driven: make it pick the fixture CA.
    await runInMain(
      app1,
      ({ dialog }, file) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never
      },
      CA_FILE,
    )

    await page.getByRole("button", { name: "Menu" }).click()
    await page.getByRole("menuitem", { name: "Custom CA Certificate…" }).click()
    const dialog = page.getByRole("dialog", { name: "Custom CA Certificate" })
    await expect(dialog.getByText("No custom CA certificate is set.")).toBeVisible()

    await dialog.getByRole("button", { name: "Choose File…" }).click()
    await expect(dialog.getByText(CA_NAME)).toBeVisible()
    // Shown shortened (~/…), in full on hover.
    await expect(dialog.getByTitle(CA_FILE)).toBeVisible()

    expect(await mainTrust(app1)).toEqual({ trusted: true, gitCaInfo: bundle })
    expect(fs.readFileSync(bundle, "utf8")).toContain(CA_PEM)
  } finally {
    await app1.close()
  }

  const app2 = await launch()
  try {
    const page = await app2.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    // Trusted from launch, before any window asks.
    expect(await mainTrust(app2)).toEqual({ trusted: true, gitCaInfo: bundle })

    await runInMain(
      app2,
      ({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById("custom-ca")
        if (!item) throw new Error("no Custom CA Certificate menu item")
        item.click()
      },
      undefined,
    )
    const dialog = page.getByRole("dialog", { name: "Custom CA Certificate" })
    await expect(dialog.getByText(CA_NAME)).toBeVisible()

    await dialog.getByRole("button", { name: "Remove" }).click()
    await expect(dialog.getByText("No custom CA certificate is set.")).toBeVisible()

    // Back to the env it started with, where an empty value counts as unset.
    expect(await mainTrust(app2)).toEqual({ trusted: false, gitCaInfo: null })
    expect(fs.existsSync(bundle)).toBe(false)
  } finally {
    await app2.close()
  }
})
