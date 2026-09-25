import { describe, it, expect, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { GoogleIdentity } from "../../../src/services/GoogleClient.ts"
import { cleanupGoogleCredentialFiles } from "./google-credentials.ts"
import {
  activeCredentialFor,
  commitCredential,
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

/** The same block re-authenticated on the OAuth tab instead. */
const USER: GoogleIdentity = {
  email: "dev@example.com",
  accountType: "user",
  credentialType: "authorized_user",
}

const USER_JSON = JSON.stringify({
  type: "authorized_user",
  client_id: "id.apps.googleusercontent.com",
  client_secret: "secret",
  refresh_token: "1//refresh",
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
    const a = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "my-proj"), ADC_JSON)
    const b = materializeForIdentity("block-b", identityKeyFor("block-b", SA, "my-proj"), ADC_JSON)

    expect(b).not.toBe(a)
    // Block A's published GOOGLE_APPLICATION_CREDENTIALS still resolves.
    expect(fs.existsSync(a)).toBe(true)
    expect(fs.readFileSync(a, "utf-8")).toBe(ADC_JSON)
    expect(fs.existsSync(b)).toBe(true)
  })

  it("KEEPS the block's previous file until the renderer commits the new one", () => {
    // The regression this pins: main materialises during the auth IPC call, but
    // the renderer keeps publishing the OLD path as GOOGLE_APPLICATION_CREDENTIALS
    // until completeAuthentication runs — which on the OAuth tab in a
    // multi-project org waits for the user to pick a project. Releasing here
    // deleted the file a <Command googleAuthId> in that window was handed, and
    // gcloud failed with "Failed to load credential file".
    const key = identityKeyFor("block-a", SA, "my-proj")
    const first = materializeForIdentity("block-a", key, ADC_JSON)
    const second = materializeForIdentity("block-a", key, ADC_JSON)

    expect(second).not.toBe(first)
    expect(fs.existsSync(first)).toBe(true)
    expect(fs.existsSync(second)).toBe(true)
  })

  it("keeps the previous file for another project until the renderer commits", () => {
    const a = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "proj-one"), ADC_JSON)
    const b = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "proj-two"), ADC_JSON)

    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
  })
})

describe("commitCredential", () => {
  it("releases the superseded file once the renderer publishes the new one", () => {
    const key = identityKeyFor("block-a", SA, "my-proj")
    const first = materializeForIdentity("block-a", key, ADC_JSON)
    const second = materializeForIdentity("block-a", key, ADC_JSON)

    commitCredential("block-a", second)

    // A rotated key must not leave the old material lying around — just not
    // before the renderer has stopped handing it out.
    expect(fs.existsSync(first)).toBe(false)
    expect(fs.existsSync(second)).toBe(true)
  })

  it("keeps a committed path that was itself queued for release", () => {
    // The renderer re-published the credential it already had (a re-auth the
    // user abandoned back to the original identity). Committing it must not
    // delete the file it is actively naming.
    const key = identityKeyFor("block-a", SA, "my-proj")
    const first = materializeForIdentity("block-a", key, ADC_JSON)
    materializeForIdentity("block-a", key, ADC_JSON)

    commitCredential("block-a", first)

    expect(fs.existsSync(first)).toBe(true)
  })

  it("never releases another block's file", () => {
    const a = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "my-proj"), ADC_JSON)
    const bKey = identityKeyFor("block-b", SA, "my-proj")
    materializeForIdentity("block-b", bKey, ADC_JSON)
    const bSecond = materializeForIdentity("block-b", bKey, ADC_JSON)

    commitCredential("block-b", bSecond)

    expect(fs.existsSync(a)).toBe(true)
  })

  it("is a no-op for a block that has nothing queued", () => {
    const only = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "my-proj"), ADC_JSON)

    commitCredential("block-a", only)
    commitCredential("block-never-authenticated", undefined)

    expect(fs.existsSync(only)).toBe(true)
  })

  it("releases every file superseded across a multi-step flow", () => {
    // Successive re-authentications of one block can land under different
    // identity keys: the project id is part of the key. All of them are
    // superseded by what the block finally publishes, which is why both the
    // queue and the predecessor lookup are keyed on the block, not the identity.
    const first = materializeForIdentity("block-a", identityKeyFor("block-a", SA, ""), ADC_JSON)
    const second = materializeForIdentity("block-a", identityKeyFor("block-a", SA, ""), ADC_JSON)
    const withProject = materializeForIdentity(
      "block-a",
      identityKeyFor("block-a", SA, "my-proj"),
      ADC_JSON,
    )

    commitCredential("block-a", withProject)

    expect(fs.existsSync(first)).toBe(false)
    expect(fs.existsSync(second)).toBe(false)
    expect(fs.existsSync(withProject)).toBe(true)
  })

  it("releases the block's committed file when it re-authenticates under another project", () => {
    const one = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "proj-one"), ADC_JSON)
    commitCredential("block-a", one)

    const two = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "proj-two"), ADC_JSON)
    commitCredential("block-a", two)

    expect(fs.existsSync(one)).toBe(false)
    expect(fs.existsSync(two)).toBe(true)
  })

  it("releases the block's service-account file when it re-authenticates via OAuth", () => {
    // Switching tabs changes the credential type AND the principal, so no part
    // of the identity carries over — the old private key is still superseded.
    const saFile = materializeForIdentity(
      "block-a",
      identityKeyFor("block-a", SA, "my-proj"),
      ADC_JSON,
    )
    commitCredential("block-a", saFile)

    const userFile = materializeForIdentity(
      "block-a",
      identityKeyFor("block-a", USER, "my-proj"),
      USER_JSON,
    )
    commitCredential("block-a", userFile)

    expect(fs.existsSync(saFile)).toBe(false)
    expect(fs.readFileSync(userFile, "utf-8")).toBe(USER_JSON)
  })

  it("forgets the previous runbook's files on reset without releasing them", () => {
    // A runbook switch does not stop running executions, so a step from the
    // previous runbook may still be reading the file; the will-quit sweep
    // removes it. And the next runbook's block with the same id must not
    // inherit it as a predecessor to release.
    const previousRunbook = materializeForIdentity(
      "block-a",
      identityKeyFor("block-a", SA, "my-proj"),
      ADC_JSON,
    )
    commitCredential("block-a", previousRunbook)

    resetGoogleCredentialRegistry()

    const nextRunbook = materializeForIdentity(
      "block-a",
      identityKeyFor("block-a", SA, "my-proj"),
      ADC_JSON,
    )
    commitCredential("block-a", nextRunbook)

    expect(fs.existsSync(previousRunbook)).toBe(true)
    expect(fs.existsSync(nextRunbook)).toBe(true)
  })

  it("never releases a file another block has registered as its own credential", () => {
    // Block B's detection read block A's GOOGLE_APPLICATION_CREDENTIALS output
    // and confirmed it as an existing file, so B is publishing A's file too.
    const aFirst = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "my-proj"), ADC_JSON)
    setActiveCredential("block-a", credential(aFirst))
    commitCredential("block-a", aFirst)
    setActiveCredential("block-b", credential(aFirst))

    const aSecond = materializeForIdentity("block-a", identityKeyFor("block-a", SA, "my-proj"), ADC_JSON)
    setActiveCredential("block-a", credential(aSecond))
    commitCredential("block-a", aSecond)

    expect(fs.existsSync(aFirst)).toBe(true)
    expect(activeCredentialFor("block-b")?.credentialsPath).toBe(aFirst)
  })
})

describe("a re-authentication that materialises nothing", () => {
  /** One block's service-account key, materialised, registered and published. */
  const committedServiceAccountFile = (blockId: string): string => {
    const saFile = materializeForIdentity(blockId, identityKeyFor(blockId, SA, "my-proj"), ADC_JSON)
    setActiveCredential(blockId, credential(saFile))
    commitCredential(blockId, saFile)
    // Registering the file the block just materialised queues nothing.
    expect(fs.existsSync(saFile)).toBe(true)
    return saFile
  }

  it("releases the block's service-account file once it publishes an existing ADC file", () => {
    // The gcloud Config tab, or detection of a GOOGLE_APPLICATION_CREDENTIALS
    // path: the credential is a file the user already had, reused as-is.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcloud-config-"))
    const userAdc = path.join(userDir, "application_default_credentials.json")
    fs.writeFileSync(userAdc, USER_JSON)
    try {
      const saFile = committedServiceAccountFile("block-a")

      setActiveCredential("block-a", {
        ref: { kind: "file", path: userAdc },
        credentialsPath: userAdc,
        principal: USER.email,
        credentialType: "authorized_user",
      })
      // Not before the renderer stops publishing the old path.
      expect(fs.existsSync(saFile)).toBe(true)

      commitCredential("block-a", userAdc)

      expect(fs.existsSync(saFile)).toBe(false)
      // The user's own file is never ours to release.
      expect(fs.readFileSync(userAdc, "utf-8")).toBe(USER_JSON)
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true })
    }
  })

  it("releases the block's service-account file once it publishes a bare access token", () => {
    const saFile = committedServiceAccountFile("block-a")

    setActiveCredential("block-a", {
      ref: { kind: "access_token", accessToken: "ya29.token" },
      principal: USER.email,
      credentialType: "access_token",
    })
    expect(fs.existsSync(saFile)).toBe(true)

    commitCredential("block-a", undefined)

    expect(fs.existsSync(saFile)).toBe(false)
  })

  it("does not queue an overlapping flow's newer file when an earlier flow registers", () => {
    // Two auth flows on one block overlap: each writes the session env between
    // materialising and registering, so the second can materialise before the
    // first registers. The renderer then publishes them in order.
    const key = identityKeyFor("block-a", SA, "my-proj")
    const earlier = materializeForIdentity("block-a", key, ADC_JSON)
    const later = materializeForIdentity("block-a", key, ADC_JSON)
    setActiveCredential("block-a", credential(earlier))
    setActiveCredential("block-a", credential(later))

    commitCredential("block-a", earlier)
    expect(fs.existsSync(later)).toBe(true)

    commitCredential("block-a", later)
    expect(fs.existsSync(earlier)).toBe(false)
    expect(fs.existsSync(later)).toBe(true)
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
