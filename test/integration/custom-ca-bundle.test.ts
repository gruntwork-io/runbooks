import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { execFile, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as https from "node:https"
import * as os from "node:os"
import * as path from "node:path"
import * as tls from "node:tls"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import {
  CA_BUNDLE_ENV_VARS,
  caBundleEnv,
  caBundleText,
  parseCustomCa,
} from "../../src/domain/tls/custom-ca.ts"
import { installSystemTrust } from "../../src/domain/tls/system-ca.ts"

// The custom CA certificate setting (electron/main/custom-ca.ts) against real
// TLS clients: the fixture CA, read the way the setting reads a file, trusted
// by main's own fetch, and handed through the bundle file and its env vars to
// the programs scripts run, against a real https server it issued the
// certificate of.
//
// Node-only (vitest, environment: node) for tls.setDefaultCACertificates, as
// in tls-custom-ca.test.ts.

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "tls",
)
const parsed = parseCustomCa(fs.readFileSync(path.join(fixtureDir, "ca.pem")))
if (!parsed.ok) throw new Error(parsed.error)
const customCaPems = parsed.pems

const defaultsSnapshot = tls.getCACertificates("default")

let server: https.Server
let baseUrl: string
let tmpDir: string
let bundleFile: string

beforeAll(async () => {
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(fixtureDir, "localhost-key.pem")),
      cert: fs.readFileSync(path.join(fixtureDir, "localhost-cert.pem")),
    },
    (_req, res) => {
      // Every request is answered, so a client that got this far trusted the server.
      res.statusCode = 404
      res.end()
    },
  )
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-custom-ca-it-"))
  // What the app writes: everything main trusts, the custom CA among it.
  bundleFile = path.join(tmpDir, "custom-ca-bundle.pem")
  fs.writeFileSync(bundleFile, caBundleText([...defaultsSnapshot, ...customCaPems]))
})

afterAll(async () => {
  tls.setDefaultCACertificates(defaultsSnapshot)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

/** A child's env: the CA vars as the app sets them with a custom CA (`withBundle`) or without. */
const childEnv = (withBundle: boolean): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // No config, credentials or prompts of the machine's own.
    HOME: tmpDir,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const [name, value] of Object.entries(
    caBundleEnv(withBundle ? bundleFile : undefined, {}),
  )) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return env
}

/** Run a program to its end: its exit code (or error code) and all it printed. Async, so the server answers. */
const run = (command: string, args: string[], withBundle: boolean) =>
  new Promise<{ code: number | string; output: string }>((resolve) => {
    execFile(
      command,
      args,
      { env: childEnv(withBundle), timeout: 20_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code ?? "failed") : 0
        resolve({ code, output: `${stdout}${stderr}` })
      },
    )
  })

/** Whether `command` is installed. Sync is fine here: no server is waiting on it. */
const has = (command: string) => spawnSync(command, ["--version"]).error === undefined

describe("main's own connections", () => {
  it("trust a server the custom CA issued once its re-encoded PEMs are installed", async () => {
    await expect(fetch(baseUrl)).rejects.toThrow()

    await Effect.runPromise(
      installSystemTrust(customCaPems, {
        bundledDefaults: () => [...defaultsSnapshot],
        systemPems: () => Effect.succeed([]),
        setCAs: (certs) => tls.setDefaultCACertificates(certs),
      }),
    )

    expect((await fetch(baseUrl)).status).toBe(404)
    tls.setDefaultCACertificates(defaultsSnapshot)
  })
})

describe("spawned programs, through the bundle", () => {
  it("sets every var to the bundle", () => {
    const env = childEnv(true)
    for (const name of CA_BUNDLE_ENV_VARS) expect(env[name]).toBe(bundleFile)
  })

  it("node (NODE_EXTRA_CA_CERTS)", async () => {
    const script = `fetch(${JSON.stringify(baseUrl)}).then((r) => console.log("status", r.status), (e) => { console.log("failed", e.cause?.code); process.exit(1) })`
    expect((await run(process.execPath, ["-e", script], false)).output).toContain("failed")
    expect(await run(process.execPath, ["-e", script], true)).toEqual({
      code: 0,
      output: "status 404\n",
    })
  })

  it.skipIf(!has("curl"))("curl (CURL_CA_BUNDLE)", async () => {
    const args = ["-sS", "-o", os.devNull, "-w", "%{http_code}", baseUrl]
    expect((await run("curl", args, false)).code).not.toBe(0)
    expect(await run("curl", args, true)).toEqual({ code: 0, output: "404" })
  })

  it.skipIf(!has("git"))("git over HTTPS (GIT_SSL_CAINFO)", async () => {
    const args = ["ls-remote", `${baseUrl}/repo.git`]
    const certProblem =
      /SSL certificate problem|certificate verify failed|unable to get local issuer/i
    expect((await run("git", args, false)).output).toMatch(certProblem)
    // Past TLS: the stub has no repo, so git reports that instead.
    const trusted = await run("git", args, true)
    expect(trusted.output).not.toMatch(certProblem)
    expect(trusted.output).toMatch(/not found|404/)
  })
})
