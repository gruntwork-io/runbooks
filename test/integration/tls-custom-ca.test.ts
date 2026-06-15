import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as https from "node:https"
import * as path from "node:path"
import * as tls from "node:tls"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import {
  classifyTlsError,
  coldReadSystemPems,
  installSystemTrust,
} from "../../src/domain/tls/system-ca.ts"
import type { CaSources } from "../../src/domain/tls/system-ca.ts"
import { ChildProcessSpawnerLive } from "../../src/layers/ChildProcessSpawner.ts"
import { GitLabHttpClientLive } from "../../src/layers/GitLabHttpClient.ts"
import { GitLabClient } from "../../src/services/GitLabClient.ts"
import { GitLabApiError } from "../../src/errors/index.ts"

// Integration coverage for the system-trust TLS mechanism: a custom root CA
// that Node's bundled Mozilla list does not contain breaks the global fetch
// (undici), and the
// additive installSystemTrust union recovers it — asserted through the real
// GitLabHttpClient layer, against a real node:https server. The committed
// fixture CA stands in for "a CA installed in the OS trust store", since CI
// cannot mutate a real keychain.
//
// Node-only (vitest, environment: node): Bun 1.3.x has no
// tls.setDefaultCACertificates, which is exactly why this suite lives under
// test/integration/ behind the bun-test path-ignore.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls")
const fixtureCaPem = fs.readFileSync(path.join(fixtureDir, "ca.pem"), "utf8")

// Snapshot the process-default CA list ONCE, before any
// setDefaultCACertificates call. Afterwards getCACertificates("default")
// returns the previously-installed union, so re-reading "default" later would
// compound extras into the base (the same rule the production code follows).
const defaultsSnapshot = tls.getCACertificates("default")

/** Real CaSources, as production uses them — except CI cannot mutate the OS
 *  trust store, so the fixture CA arrives via extraPems instead. */
const realTlsIo: CaSources = {
  bundledDefaults: () => [...defaultsSnapshot],
  systemPems: () => Effect.succeed([...tls.getCACertificates("system")]),
  setCAs: (certs) => tls.setDefaultCACertificates(certs),
}

interface RecordedRequest {
  readonly path: string
  readonly authorization: string | null
  readonly privateToken: string | null
}

let server: https.Server
let baseUrl: string
const requests: RecordedRequest[] = []

beforeAll(async () => {
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(fixtureDir, "localhost-key.pem")),
      cert: fs.readFileSync(path.join(fixtureDir, "localhost-cert.pem")),
    },
    (req, res) => {
      requests.push({
        path: req.url ?? "",
        authorization: (req.headers.authorization as string | undefined) ?? null,
        privateToken: (req.headers["private-token"] as string | undefined) ?? null,
      })
      if (req.url?.startsWith("/api/v4/user")) {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ id: 1, username: "fixture-user" }))
        return
      }
      if (req.url?.startsWith("/oauth/token/info")) {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ scope: ["api"] }))
        return
      }
      // /api/v4/personal_access_tokens/self lands here: a pre-15.5 GitLab
      // 404s the `self` endpoint — must be silently "no scope info".
      res.statusCode = 404
      res.end()
    },
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  // The leaf is issued for localhost (SAN: DNS:localhost, IP:127.0.0.1).
  baseUrl = `https://localhost:${port}`
})

afterAll(async () => {
  // Restore the original CA list so this suite leaves no trace for others.
  tls.setDefaultCACertificates(defaultsSnapshot)
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

const validateAgainstFixture = (token: string) =>
  Effect.gen(function* () {
    const client = yield* GitLabClient
    return yield* client.validateToken(token, baseUrl)
  }).pipe(Effect.provide(GitLabHttpClientLive))

describe("custom-CA recovery through installSystemTrust", () => {
  it("runs under a Node with tls.setDefaultCACertificates (the reason this suite is vitest/Node-only)", () => {
    expect(typeof tls.setDefaultCACertificates).toBe("function")
  })

  it("bare fetch fails with the undici-wrapped trust error and classifyTlsError says 'tls'", async () => {
    const rejection = await fetch(`${baseUrl}/api/v4/user`).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(rejection).toBeInstanceOf(TypeError)
    expect((rejection as TypeError).message).toBe("fetch failed")
    const cause = (rejection as { cause?: { code?: string } }).cause
    expect(cause?.code).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
    // The classifier must unwrap the real undici cause chain, not just fixtures.
    expect(classifyTlsError(rejection)).toBe("tls")
  })

  it("validateToken through the real GitLab layer fails with kind 'tls' — never a credential failure", async () => {
    const result = await Effect.runPromise(Effect.either(validateAgainstFixture("glpat-fixture")))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(GitLabApiError)
      expect(result.left.status).toBe(0)
      expect(result.left.kind).toBe("tls")
    }
  })

  it("installSystemTrust([fixture CA]) recovers validateToken, Bearer-first", async () => {
    const counts = await Effect.runPromise(installSystemTrust([fixtureCaPem], realTlsIo))
    expect(counts.defaults).toBeGreaterThan(0)
    expect(counts.extra).toBe(1)

    requests.length = 0
    const result = await Effect.runPromise(validateAgainstFixture("glpat-fixture"))
    expect(result.user.login).toBe("fixture-user")
    // Pre-15.5 fixture instance 404s /personal_access_tokens/self —
    // silently no scope info, never an error.
    expect(result.scopes).toBeUndefined()

    // Bearer-first, asserted on the wire via recorded headers.
    const userRequest = requests.find((r) => r.path.startsWith("/api/v4/user"))
    expect(userRequest).toBeDefined()
    expect(userRequest!.authorization).toBe("Bearer glpat-fixture")
    expect(userRequest!.privateToken).toBeNull()
  })
})

describe("system-reader contract pins (the refresh design depends on these)", () => {
  it("getCACertificates('system') is cached for process lifetime (same frozen array)", () => {
    // Documents the per-process cache the cold-read refresh design depends
    // on. If Node ever changes these semantics, this fails loudly and the
    // refresh path should be revisited (a plain in-process re-read would
    // then suffice).
    const first = tls.getCACertificates("system")
    const second = tls.getCACertificates("system")
    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it("the cold out-of-process read spawns, exits 0, returns parseable PEMs, and flows into setDefaultCACertificates", async () => {
    // Under vitest process.execPath is the node binary; ELECTRON_RUN_AS_NODE=1
    // is set by the helper and is harmless for plain node.
    const pems = await Effect.runPromise(
      coldReadSystemPems().pipe(Effect.provide(ChildProcessSpawnerLive)),
    )
    expect(Array.isArray(pems)).toBe(true)
    for (const pem of pems) {
      expect(pem).toContain("-----BEGIN CERTIFICATE-----")
    }
    // The child's output must be usable as a setDefaultCACertificates input.
    tls.setDefaultCACertificates([...defaultsSnapshot, ...pems])
    tls.setDefaultCACertificates(defaultsSnapshot)
  })
})
