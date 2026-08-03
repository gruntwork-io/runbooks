import { describe, it, expect, afterEach } from "bun:test"
import * as fs from "node:fs"
import type { GoogleIdentity } from "../../../src/services/GoogleClient.ts"
import { cleanupGoogleCredentialFiles } from "./google-credentials.ts"
import {
  activeCredentialFor,
  identityKeyFor,
  materializeForIdentity,
  resetGoogleCredentialRegistry,
  setActiveCredential,
} from "./google-credential-registry.ts"

/**
 * The documented multi-project pattern (GoogleAuth.mdx) puts two GoogleAuth
 * blocks in one runbook. These cases pin the two ways a globally-keyed registry
 * breaks that pattern: one block operating on another's credential, and one
 * block deleting the credentials file another block already published.
 */

const SA: GoogleIdentity = {
  email: "sa@p.iam.gserviceaccount.com",
  accountType: "service_account",
  credentialType: "service_account",
  projectId: "my-proj",
}

const ADC_JSON = JSON.stringify({
  type: "service_account",
  client_email: SA.email,
  private_key: "-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n",
})

const credential = (path: string) =>
  ({
    ref: { kind: "file", path } as const,
    credentialsPath: path,
    principal: SA.email,
    credentialType: "service_account" as const,
  })

afterEach(() => {
  resetGoogleCredentialRegistry()
  cleanupGoogleCredentialFiles()
})

describe("activeCredentialFor", () => {
  it("gives each block its own credential", () => {
    setActiveCredential("source-project", credential("/tmp/a/adc.json"))
    setActiveCredential("target-project", credential("/tmp/b/adc.json"))

    expect(activeCredentialFor("source-project")?.credentialsPath).toBe("/tmp/a/adc.json")
    expect(activeCredentialFor("target-project")?.credentialsPath).toBe("/tmp/b/adc.json")
  })

  it("never lets a block that has not authenticated borrow a neighbour's", () => {
    setActiveCredential("target-project", credential("/tmp/b/adc.json"))

    // The caller falls through to the session env instead — the only credential
    // it can honestly claim.
    expect(activeCredentialFor("source-project")).toBeUndefined()
  })

  it("falls back to the most recent credential only for a blockless caller", () => {
    setActiveCredential("source-project", credential("/tmp/a/adc.json"))
    setActiveCredential("target-project", credential("/tmp/b/adc.json"))

    expect(activeCredentialFor(undefined)?.credentialsPath).toBe("/tmp/b/adc.json")
  })

  it("repoints only the calling block when a project is picked", () => {
    setActiveCredential("source-project", credential("/tmp/a/adc.json"))
    setActiveCredential("target-project", credential("/tmp/b/adc.json"))

    activeCredentialFor("source-project")!.projectId = "picked-in-source"

    expect(activeCredentialFor("target-project")?.projectId).toBeUndefined()
  })
})

describe("materializeForIdentity", () => {
  it("keeps two blocks' files apart even for an IDENTICAL key and project", () => {
    // Two blocks fed the same service-account key and project — the multi-block
    // pattern where they differ only in, say, defaultRegion.
    const a = materializeForIdentity(identityKeyFor("block-a", SA, "my-proj"), ADC_JSON)
    const b = materializeForIdentity(identityKeyFor("block-b", SA, "my-proj"), ADC_JSON)

    expect(b).not.toBe(a)
    // Block A's published GOOGLE_APPLICATION_CREDENTIALS still resolves.
    expect(fs.existsSync(a)).toBe(true)
    expect(fs.readFileSync(a, "utf-8")).toBe(ADC_JSON)
    expect(fs.existsSync(b)).toBe(true)
  })

  it("releases the block's OWN previous file when it re-authenticates", () => {
    const key = identityKeyFor("block-a", SA, "my-proj")
    const first = materializeForIdentity(key, ADC_JSON)
    const second = materializeForIdentity(key, ADC_JSON)

    expect(second).not.toBe(first)
    // A rotated key must not leave the old material lying around.
    expect(fs.existsSync(first)).toBe(false)
    expect(fs.existsSync(second)).toBe(true)
  })

  it("treats a different project on the same block as a different credential", () => {
    const a = materializeForIdentity(identityKeyFor("block-a", SA, "proj-one"), ADC_JSON)
    const b = materializeForIdentity(identityKeyFor("block-a", SA, "proj-two"), ADC_JSON)

    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
  })
})

describe("identityKeyFor", () => {
  it("includes the block id, so identical identities in different blocks differ", () => {
    expect(identityKeyFor("block-a", SA, "my-proj")).not.toBe(
      identityKeyFor("block-b", SA, "my-proj"),
    )
  })

  it("is stable for the same block, identity, and project", () => {
    expect(identityKeyFor("block-a", SA, "my-proj")).toBe(identityKeyFor("block-a", SA, "my-proj"))
  })
})
