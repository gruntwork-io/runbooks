/**
 * VCS auth E2E flights.
 *
 * These launch the real Electron app against a local https GitLab stub built
 * from the committed TLS fixtures (test/fixtures/tls/), with stub gh/glab
 * shims (test/fixtures/vcs-cli/) prepended to PATH. TERM_PROGRAM is set so
 * populateShellEnv never replaces the test-controlled PATH.
 *
 * Scope honesty:
 * - The TLS-card Retry flight exercises the RUNBOOKS_TEST_EXTRA_CA extraPems
 *   seam and the refresh plumbing; the OS-store-mutated-mid-session leg is
 *   physically untestable in CI and is covered by the manual QA gate
 *   (docs/qa/custom-ca-release-gate.md).
 * - The GitHub Check-again flight asserts re-detection without reload via the
 *   invalid-token chip: a full zero-click success leg would require
 *   api.github.com to accept a stub token (validation is a direct main-process
 *   fetch that Playwright cannot intercept).
 * - After restart, a manually-added host is asserted as a `recent` dropdown
 *   entry; it is deliberately NOT preselected because it has no offline
 *   credential — the defaultHost rule (hasCredential gate) wins over the
 *   sketch here.
 */
import { test, expect, _electron as electron } from "@playwright/test"
import type { ElectronApplication, Page } from "@playwright/test"
import * as fs from "node:fs"
import * as https from "node:https"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")
const TLS_FIXTURES = path.join(ROOT, "test/fixtures/tls")
const STUB_DIR = path.join(ROOT, "test/fixtures/vcs-cli")
const GITLAB_RUNBOOK = path.join(ROOT, "test/fixtures/runbooks/gitlab-auth")
const GITHUB_RUNBOOK = path.join(ROOT, "test/fixtures/runbooks/github-auth")

const CA_PEM = fs.readFileSync(path.join(TLS_FIXTURES, "ca.pem"), "utf8")

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface LaunchResult {
  app: ElectronApplication
  window: Page
  logs: () => string
}

/** Launch the app on a runbook with a controlled environment. Ambient token
 *  env vars are always stripped for determinism. */
async function launchApp(runbook: string, env: Record<string, string>): Promise<LaunchResult> {
  const cleanEnv: Record<string, string> = { ...process.env } as Record<string, string>
  for (const v of ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_HOST", "GITLAB_URI", "GL_HOST", "GH_HOST", "GLAB_CONFIG_DIR", "GH_CONFIG_DIR"]) {
    delete cleanEnv[v]
  }
  const collected: string[] = []
  const app = await electron.launch({
    args: [MAIN_ENTRY, runbook],
    env: {
      ...cleanEnv,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_NO_TELEMETRY: "1",
      // Skip populateShellEnv so the test-controlled PATH survives.
      TERM_PROGRAM: "runbooks-e2e",
      ...env,
    },
  })
  app.process().stdout?.on("data", (chunk) => collected.push(String(chunk)))
  app.process().stderr?.on("data", (chunk) => collected.push(String(chunk)))
  const window = await app.firstWindow()
  await window.waitForLoadState("domcontentloaded")
  return { app, window, logs: () => collected.join("") }
}

/** Local https GitLab API stub using the committed fixture leaf. */
async function startGitLabStub(): Promise<{ host: string; close: () => Promise<void> }> {
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(TLS_FIXTURES, "localhost-key.pem")),
      cert: fs.readFileSync(path.join(TLS_FIXTURES, "localhost-cert.pem")),
    },
    (req, res) => {
      if (req.url?.startsWith("/api/v4/user")) {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ id: 1, username: "tanuki", name: "Tanuki E2E" }))
        return
      }
      if (req.url?.startsWith("/oauth/token/info")) {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ scope: ["api"] }))
        return
      }
      // /api/v4/personal_access_tokens/self → pre-15.5 behavior (404 = no scope info)
      res.statusCode = 404
      res.end()
    },
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    host: `localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeGlabConfig(dir: string, yaml: string): void {
  fs.writeFileSync(path.join(dir, "config.yml"), yaml)
}

const stubPath = (): string => `${STUB_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`

// ---------------------------------------------------------------------------
// in-Electron trust canary
// ---------------------------------------------------------------------------

test("trust canary: the in-Electron system-store read matches the host's", async () => {
  // The launch log line fires before Playwright can attach stdout listeners,
  // so the canary asserts the invariant directly in the MAIN process: the
  // shipped Electron binary's system-store reader returns what THIS HOST's
  // Node reader returns (CI runners have OS-store certs, so there it is the
  // `system > 0` check; a clean dev keychain legitimately reads 0), and
  // the installed default list is the union. Catches Electron/BoringSSL and
  // Node system-reader regressions before the field canary does.
  const tlsHost = await import("node:tls")
  const hostSystemCount = tlsHost.getCACertificates("system").length

  const { app } = await launchApp(GITHUB_RUNBOOK, {})
  try {
    const counts = await app.evaluate(() => {
      // The built main is ESM — no `require` in the evaluate scope.
      const tls = process.getBuiltinModule("node:tls")
      return {
        system: tls.getCACertificates("system").length,
        installedDefault: tls.getCACertificates("default").length,
      }
    })
    // Reader parity: an in-Electron read that comes up empty while the host
    // has certs is exactly the regression class this canary exists to catch.
    if (hostSystemCount > 0) {
      expect(counts.system).toBeGreaterThan(0)
    }
    expect(counts.system).toBeGreaterThanOrEqual(Math.min(hostSystemCount, 1))
    // After installSystemTrust, "default" returns the installed union — it
    // must hold at least the Mozilla bundle.
    expect(counts.installedDefault).toBeGreaterThan(100)
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------------------
// GitLab two-host dropdown + ca_cert harvest zero-click flight
// (hard requirements 1, 2, and 4 in one flight)
// ---------------------------------------------------------------------------

test("gitlab: two-host dropdown, ca_cert harvest, zero-click self-hosted success", async () => {
  const stub = await startGitLabStub()
  const configDir = makeTempDir("rb-glab-")
  const token = "glpat-e2e-fixture-token"
  writeGlabConfig(
    configDir,
    [
      `host: ${stub.host}`,
      "hosts:",
      "    gitlab.com:",
      "        user: someone",
      `    ${stub.host}:`,
      `        token: ${token}`,
      `        ca_cert: ${path.join(TLS_FIXTURES, "ca.pem")}`,
      "",
    ].join("\n"),
  )

  const { app, window } = await launchApp(GITLAB_RUNBOOK, {
    PATH: stubPath(),
    GLAB_CONFIG_DIR: configDir,
    GLAB_STUB_TOKEN: token,
  })
  try {
    // Zero-click: detection lands on glab's default host (the self-hosted
    // stub), the ca_cert harvest makes its CA trusted, the per-host CLI
    // read supplies the token, and direct validation succeeds.
    await expect(window.getByText(`✓ Authenticated to GitLab (${stub.host})`)).toBeVisible({
      timeout: 45_000,
    })
    // source line names the CLI.
    await expect(window.getByText("Detected from glab CLI")).toBeVisible()

    // the select renders with provenance and credential indicators, plus
    // the "Other instance…" row.
    const select = window.locator(`#gitlab-host-gl-auth`)
    await expect(select).toBeVisible()
    const options = await select.locator("option").allTextContents()
    expect(options).toContain("gitlab.com")
    expect(options).toContain(stub.host)
    expect(options).toContain("Other instance…")
    await expect(select).toHaveValue(stub.host)
    await expect(window.getByTestId("host-credential-gl-auth")).toBeVisible()
  } finally {
    await app.close()
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// TLS card (never "Invalid credentials detected") + Retry via the
// extraPems seam + cold-read refresh plumbing
// ---------------------------------------------------------------------------

test("gitlab: untrusted CA renders the TLS card, Retry + injected CA recovers without relaunch", async () => {
  const stub = await startGitLabStub()
  const configDir = makeTempDir("rb-glab-tls-")
  const seamDir = makeTempDir("rb-seam-")
  const seamPath = path.join(seamDir, "inject-ca.pem")
  const token = "glpat-e2e-tls-token"
  // No ca_cert for the host: the CA is untrusted at launch.
  writeGlabConfig(
    configDir,
    [`host: ${stub.host}`, "hosts:", `    ${stub.host}:`, `        token: ${token}`, ""].join("\n"),
  )

  const { app, window, logs } = await launchApp(GITLAB_RUNBOOK, {
    PATH: stubPath(),
    GLAB_CONFIG_DIR: configDir,
    GLAB_STUB_TOKEN: token,
    RUNBOOKS_TEST_EXTRA_CA: seamPath, // does not exist yet
    // The probe must FAIL here so the card (not degraded auth) shows:
    // the stub's `glab api user` 401s unless GLAB_STUB_API_BODY is set.
  })
  try {
    const card = window.getByTestId("vcs-unreachable-card")
    await expect(card).toBeVisible({ timeout: 45_000 })
    await expect(card).toHaveAttribute("data-error-kind", "tls")
    // the cert-chain diagnostic, and never the misdiagnosis.
    await expect(card).toContainText("Invalid certificate chain")
    await expect(card).toContainText("Check the local CA root")
    await expect(window.getByText("Invalid credentials detected")).toHaveCount(0)
    // The automatic pre-card refresh ran the cold-read child.
    expect(logs()).toContain("(refresh, coldReadOk=")

    // Mid-session CA install via the test seam, then Retry — no relaunch.
    fs.writeFileSync(seamPath, CA_PEM)
    await card.getByRole("button", { name: "Retry" }).click()
    await expect(window.getByText(`✓ Authenticated to GitLab (${stub.host})`)).toBeVisible({
      timeout: 45_000,
    })
  } finally {
    await app.close()
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// probe-path integration — detect → tls-fail → probe → degraded
// success, without network
// ---------------------------------------------------------------------------

test("gitlab: probe converts a TLS wall into degraded auth with the transparency line", async () => {
  const stub = await startGitLabStub()
  const configDir = makeTempDir("rb-glab-probe-")
  const token = "glpat-e2e-probe-token"
  writeGlabConfig(
    configDir,
    [`host: ${stub.host}`, "hosts:", `    ${stub.host}:`, `        token: ${token}`, ""].join("\n"),
  )

  const { app, window, logs } = await launchApp(GITLAB_RUNBOOK, {
    PATH: stubPath(),
    GLAB_CONFIG_DIR: configDir,
    GLAB_STUB_TOKEN: token,
    // The probe (`glab api user --hostname H`) succeeds via the stub even
    // though the app's direct transport cannot trust the fixture CA.
    GLAB_STUB_API_BODY: JSON.stringify({ username: "tanuki", name: "Tanuki E2E" }),
  })
  try {
    await expect(window.getByText(`✓ Authenticated to GitLab (${stub.host})`)).toBeVisible({
      timeout: 45_000,
    })
    // transparency line + the structured field canary.
    await expect(window.getByTestId("transport-degraded-line")).toBeVisible()
    await expect(window.getByTestId("transport-degraded-line")).toContainText("validated via glab CLI")
    expect(logs()).toContain(`transport degraded for ${stub.host}`)
  } finally {
    await app.close()
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// GitHub manual UI, OAuth tab presence, hint copy, Check again
// ---------------------------------------------------------------------------

test("github: logged-out gh → manual UI with hint; Check again re-detects without reload", async () => {
  const stateDir = makeTempDir("rb-gh-state-")
  const stateFile = path.join(stateDir, "gh-state")

  const { app, window } = await launchApp(GITHUB_RUNBOOK, {
    PATH: stubPath(),
    GH_STUB_STATE_FILE: stateFile, // absent → logged out
    GH_CONFIG_DIR: makeTempDir("rb-gh-empty-"),
  })
  try {
    // Nothing found → manual UI with the hint line + Check again control,
    // and the OAuth tab is a first-class tab even though gh is installed.
    await expect(
      window.getByText("No existing credentials found. Sign in below, set GITHUB_TOKEN, or run 'gh auth login'."),
    ).toBeVisible({ timeout: 45_000 })
    await expect(window.getByRole("button", { name: /Sign in with GitHub/ }).first()).toBeVisible()
    await expect(window.getByRole("button", { name: "Check again" })).toBeVisible()

    // Terminal login happens (the stub flips to a token gh now returns).
    // Check again re-runs detection in place — no runbook reload. The stub
    // token 401s against api.github.com, which is exactly the point: the
    // chain re-ran and produced the found-but-invalid chip.
    fs.writeFileSync(stateFile, "ghp_e2e_invalid_token_0000000000000000\n")
    await window.getByRole("button", { name: "Check again" }).click()
    await expect(window.getByText("GitHub CLI token is invalid or expired")).toBeVisible({
      timeout: 45_000,
    })
    // Still never the device-flow regression: OAuth tab remains available.
    await expect(window.getByRole("button", { name: /Sign in with GitHub/ }).first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test("github: gh absent → install hint, OAuth tab still present", async () => {
  const { app, window } = await launchApp(GITHUB_RUNBOOK, {
    PATH: "/usr/bin:/bin", // no gh anywhere
    GH_CONFIG_DIR: makeTempDir("rb-gh-empty-"), // a real ~/.config/gh must not leak in
  })
  try {
    await expect(
      window.getByText("No existing credentials found. Sign in below, set GITHUB_TOKEN, or install the GitHub CLI (gh)."),
    ).toBeVisible({ timeout: 45_000 })
    await expect(window.getByRole("button", { name: /Sign in with GitHub/ }).first()).toBeVisible()
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------------------
// "Other instance…" sentinel → PAT success → recents + persistence
// ---------------------------------------------------------------------------

test("gitlab: Other instance… sentinel, PAT success, recent persisted across restart", async () => {
  const stub = await startGitLabStub()
  const configDir = makeTempDir("rb-glab-other-")
  const userDataDir = makeTempDir("rb-userdata-")
  const seamDir = makeTempDir("rb-seam2-")
  const seamPath = path.join(seamDir, "ca.pem")
  fs.writeFileSync(seamPath, CA_PEM) // trusted from launch (PAT validation target)
  // gitlab.com-only config, no credential: single-host case still renders the
  // select with the Other instance… row.
  writeGlabConfig(configDir, ["host: gitlab.com", "hosts:", "    gitlab.com:", "        user: someone", ""].join("\n"))

  const env = {
    PATH: stubPath(),
    GLAB_CONFIG_DIR: configDir,
    GLAB_STUB_EMPTY: "1", // contract (b): host not configured → manual UI
    RUNBOOKS_TEST_EXTRA_CA: seamPath,
    RUNBOOKS_TEST_USER_DATA_DIR: userDataDir,
  }

  const first = await launchApp(GITLAB_RUNBOOK, env)
  try {
    const select = first.window.locator(`#gitlab-host-gl-auth`)
    await expect(select).toBeVisible({ timeout: 45_000 })
    await expect(select).toHaveValue("gitlab.com")

    // The sentinel never changes the host and never runs detection — the
    // select snaps back and the PAT form (with the instance-URL field) shows.
    await select.selectOption("__other__")
    await expect(select).toHaveValue("gitlab.com")
    const instanceField = first.window.getByPlaceholder("https://gitlab.com")
    await expect(instanceField).toBeVisible()

    await instanceField.fill(`https://${stub.host}`)
    await first.window.locator('input[type="password"]').fill("glpat-e2e-manual-pat")
    await first.window.getByRole("button", { name: "Authenticate", exact: true }).click()
    await expect(first.window.getByText(`✓ Authenticated to GitLab (${stub.host})`)).toBeVisible({
      timeout: 45_000,
    })

    // Persistence (hostnames only — never tokens).
    const store = JSON.parse(fs.readFileSync(path.join(userDataDir, "vcs-auth.json"), "utf8"))
    expect(store.recentGitLabHosts).toContain(stub.host)
    expect(store.lastSelectedGitLabHost).toBe(stub.host)
    expect(JSON.stringify(store)).not.toContain("glpat-")
  } finally {
    await first.app.close()
  }

  // Restart: the manual host appears as a `recent` union entry. (It is NOT
  // preselected: it has no offline credential, and the defaultHost rule —
  // a credential-less stale pick must not steal auto-detect — wins.)
  const second = await launchApp(GITLAB_RUNBOOK, env)
  try {
    const select = second.window.locator(`#gitlab-host-gl-auth`)
    await expect(select).toBeVisible({ timeout: 45_000 })
    const options = await select.locator("option").allTextContents()
    expect(options).toContain(stub.host)
    await select.selectOption(stub.host)
    await expect(second.window.getByTestId(`host-sources-gl-auth`)).toContainText("recent")
  } finally {
    await second.app.close()
    await stub.close()
  }
})
