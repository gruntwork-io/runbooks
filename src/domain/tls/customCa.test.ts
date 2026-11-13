import { describe, expect, it } from "bun:test"
import { X509Certificate } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  CA_BUNDLE_ENV_VARS,
  caBundleEnv,
  caBundleText,
  parseCustomCa,
  pemCertificateBlocks,
} from "./customCa.ts"

// The committed TLS fixtures: a root CA, and a localhost server certificate it issued.
const FIXTURES = path.join(import.meta.dir, "../../../test/fixtures/tls")
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name))
const CA = read("ca.pem")
const LEAF = read("localhost-cert.pem")
const KEY = read("ca-key.pem")
const bytes = (text: string) => new TextEncoder().encode(text)

describe("parseCustomCa", () => {
  it("reads a PEM CA certificate", () => {
    const parsed = parseCustomCa(CA)
    if (!parsed.ok) throw new Error(parsed.error)

    expect(parsed.certificates).toEqual([
      {
        subject: "Runbooks TLS Test Fixture CA",
        issuer: "Runbooks TLS Test Fixture CA",
        validFrom: "2026-06-11T08:44:39.000Z",
        validTo: "2126-05-18T08:44:39.000Z",
        fingerprint256: new X509Certificate(CA).fingerprint256,
        isCa: true,
      },
    ])
    // Re-encoded the way Node encodes its own lists, so they dedupe.
    expect(parsed.pems).toEqual([new X509Certificate(CA).toString()])
  })

  it("reads every certificate of a bundle, in order, ignoring text around them", () => {
    const bundle = `Acme root, then the server\n${CA.toString()}\n# comment\n${LEAF.toString()}`
    const parsed = parseCustomCa(bytes(bundle))
    if (!parsed.ok) throw new Error(parsed.error)

    expect(parsed.certificates.map((c) => [c.subject, c.issuer, c.isCa])).toEqual([
      ["Runbooks TLS Test Fixture CA", "Runbooks TLS Test Fixture CA", true],
      ["localhost", "Runbooks TLS Test Fixture CA", false],
    ])
    expect(parsed.pems).toHaveLength(2)
  })

  it("reads a DER certificate, as Windows exports a .cer, and returns it as PEM", () => {
    const der = new X509Certificate(CA).raw
    const parsed = parseCustomCa(der)
    if (!parsed.ok) throw new Error(parsed.error)

    expect(parsed.certificates[0]!.subject).toBe("Runbooks TLS Test Fixture CA")
    expect(parsed.pems[0]).toStartWith("-----BEGIN CERTIFICATE-----")
  })

  it("rejects a private key picked by mistake", () => {
    expect(parseCustomCa(KEY)).toEqual({
      ok: false,
      error: "The file has no certificates. Choose the CA's certificate, not a key.",
    })
  })

  it("rejects a file that is no certificate at all", () => {
    const parsed = parseCustomCa(bytes("just some text"))
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toStartWith("The file isn't a certificate.")
  })

  it("says which certificate of a bundle is broken", () => {
    const broken = "-----BEGIN CERTIFICATE-----\nnot base64 der\n-----END CERTIFICATE-----"
    const parsed = parseCustomCa(bytes(`${CA.toString()}\n${broken}`))
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toStartWith("Certificate 2 of 2 in the file can't be read")
  })
})

describe("pemCertificateBlocks", () => {
  it("finds the certificate blocks and nothing else", () => {
    const text = `${KEY.toString()}\n${CA.toString()}\n${LEAF.toString()}`
    expect(pemCertificateBlocks(text).map((pem) => pem.trim())).toEqual([
      CA.toString().trim(),
      LEAF.toString().trim(),
    ])
    expect(pemCertificateBlocks("")).toEqual([])
  })
})

describe("caBundleText", () => {
  it("joins the PEMs one per block, deduped, ending in a newline", () => {
    const a = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----"
    const b = "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----"
    expect(caBundleText([`${a}\n`, b, a])).toBe(`${a}\n${b}\n`)
  })
})

describe("caBundleEnv", () => {
  it("points every var at the bundle while a custom CA is set", () => {
    const env = caBundleEnv("/data/custom-ca-bundle.pem", { SSL_CERT_FILE: "/etc/corp.pem" })
    expect(Object.keys(env)).toEqual([...CA_BUNDLE_ENV_VARS])
    expect(new Set(Object.values(env))).toEqual(new Set(["/data/custom-ca-bundle.pem"]))
  })

  it("puts back the values the app started with, unsetting the rest", () => {
    const env = caBundleEnv(undefined, { SSL_CERT_FILE: "/etc/corp.pem" })
    expect(env.SSL_CERT_FILE).toBe("/etc/corp.pem")
    expect(env.GIT_SSL_CAINFO).toBeUndefined()
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })
})
