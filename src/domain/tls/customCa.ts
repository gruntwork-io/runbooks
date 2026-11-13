/**
 * Custom CA certificate domain module: reading the certificate file a user
 * picks from the menu (Custom CA Certificate…), and the env vars that hand the
 * app's trust to the processes it spawns.
 *
 * Pure: the Electron side (electron/main/custom-ca.ts) reads, saves and
 * installs the file. node:crypto's X509Certificate is only a parser here.
 */
import { X509Certificate } from "node:crypto"
import { errorMessage } from "../../errors/message.ts"
import { dedupePems } from "./system-ca.ts"

/** One certificate from the file, as the Custom CA Certificate dialog shows it. */
export interface CaCertificateSummary {
  /** The subject's common name, or the whole subject when it has none. */
  readonly subject: string
  /** The issuer's common name, or the whole issuer when it has none. */
  readonly issuer: string
  /** ISO 8601. */
  readonly validFrom: string
  /** ISO 8601. */
  readonly validTo: string
  /** SHA-256, as colon-separated hex (`openssl x509 -fingerprint -sha256`). */
  readonly fingerprint256: string
  /** Whether its basic constraints make it a CA certificate. */
  readonly isCa: boolean
}

/** The custom CA setting, as the dialog shows it. */
export interface CustomCaStatus {
  /** The certificate file, when one is set. */
  readonly path?: string
  /** The file's certificates, all of which Runbooks trusts. Empty when `error` is set. */
  readonly certificates: readonly CaCertificateSummary[]
  /** Why the file's certificates aren't trusted: it is gone, unreadable, or has none. */
  readonly error?: string
}

export type ParsedCustomCa =
  | {
      readonly ok: true
      /** Each certificate, PEM-encoded, ready for tls.setDefaultCACertificates. */
      readonly pems: string[]
      readonly certificates: CaCertificateSummary[]
    }
  | { readonly ok: false; readonly error: string }

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

/** The PEM certificate blocks in `text`, in order. Anything around them is ignored. */
export const pemCertificateBlocks = (text: string): string[] => text.match(PEM_CERTIFICATE) ?? []

/** A distinguished name's CN, or the whole name when it has none. Node puts one RDN per line. */
const commonName = (name: string): string => {
  const rdns = name.split("\n").filter((rdn) => rdn.length > 0)
  const cn = rdns.find((rdn) => rdn.startsWith("CN="))
  return cn ? cn.slice("CN=".length) : rdns.join(", ")
}

const summarize = (cert: X509Certificate): CaCertificateSummary => ({
  subject: commonName(cert.subject),
  issuer: commonName(cert.issuer),
  validFrom: new Date(cert.validFrom).toISOString(),
  validTo: new Date(cert.validTo).toISOString(),
  fingerprint256: cert.fingerprint256,
  isCa: cert.ca,
})

/**
 * Read a certificate file: PEM with one or more certificates (a bundle, such
 * as a root and its intermediates), or a single DER-encoded certificate, which
 * is how Windows exports a `.cer` by default. Fails with a sentence fit to show
 * the user when the file holds no certificate, or one that can't be parsed.
 *
 * The PEMs are re-encoded from the parsed certificates, so they match the
 * formatting of Node's own lists and dedupe against them.
 */
export const parseCustomCa = (contents: Uint8Array): ParsedCustomCa => {
  const text = new TextDecoder().decode(contents)
  const blocks = pemCertificateBlocks(text)

  let certs: X509Certificate[]
  if (blocks.length > 0) {
    certs = []
    for (const [index, block] of blocks.entries()) {
      try {
        certs.push(new X509Certificate(block))
      } catch (err) {
        const which =
          blocks.length > 1 ? `Certificate ${index + 1} of ${blocks.length}` : "The certificate"
        return { ok: false, error: `${which} in the file can't be read: ${errorMessage(err)}` }
      }
    }
  } else if (text.includes("-----BEGIN ")) {
    // PEM, but no certificate in it: most often a private key picked by mistake.
    return {
      ok: false,
      error: "The file has no certificates. Choose the CA's certificate, not a key.",
    }
  } else {
    try {
      certs = [new X509Certificate(contents)]
    } catch {
      return {
        ok: false,
        error:
          "The file isn't a certificate. Choose a PEM (.pem, .crt) or DER (.cer) certificate file.",
      }
    }
  }

  return {
    ok: true,
    pems: certs.map((cert) => cert.toString()),
    certificates: certs.map(summarize),
  }
}

// ---------------------------------------------------------------------------
// Spawned processes
// ---------------------------------------------------------------------------

/**
 * The env vars that point a spawned process's TLS client at a CA bundle file,
 * with what reads each. All but NODE_EXTRA_CA_CERTS REPLACE the tool's own
 * trust list, so the file they point at must hold everything the app trusts
 * (Node's bundled roots, the OS store, …) plus the custom CA, never the custom
 * CA alone.
 *
 * Go programs (OpenTofu, Terragrunt, gh, glab) read SSL_CERT_FILE on Linux,
 * and on macOS and Windows from Go 1.27, where it replaces the OS trust store
 * (GODEBUG x509sslcertoverrideplatform). Built with an older Go, they use the
 * OS trust store alone there: OpenTofu 1.12 and earlier, for one. Those still
 * read AWS_CA_BUNDLE for their S3 backend and AWS provider, and fetch git
 * module sources with git.
 */
export const CA_BUNDLE_ENV_VARS = [
  "NODE_EXTRA_CA_CERTS", // Node, added to its own roots
  "SSL_CERT_FILE", // OpenSSL's default file (Python's ssl, Ruby); Go, see above
  "GIT_SSL_CAINFO", // git over HTTPS; outranks http.sslCAInfo in git config
  "CURL_CA_BUNDLE", // curl
  "REQUESTS_CA_BUNDLE", // Python requests, which ignores SSL_CERT_FILE
  "AWS_CA_BUNDLE", // AWS CLI and SDKs
  "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE", // gcloud
] as const

export type CaBundleEnvVar = (typeof CA_BUNDLE_ENV_VARS)[number]

/** The CA bundle file CA_BUNDLE_ENV_VARS point at: `pems`, deduped, one after another. */
export const caBundleText = (pems: readonly string[]): string =>
  `${dedupePems([...pems])
    .map((pem) => pem.trim())
    .join("\n")}\n`

/**
 * What to set CA_BUNDLE_ENV_VARS to: all of them to `bundlePath` while a
 * custom CA is set, else back to `original`, the values the app started with
 * (undefined: unset).
 */
export const caBundleEnv = (
  bundlePath: string | undefined,
  original: Readonly<Partial<Record<CaBundleEnvVar, string>>>,
): Record<CaBundleEnvVar, string | undefined> => {
  const env = {} as Record<CaBundleEnvVar, string | undefined>
  for (const name of CA_BUNDLE_ENV_VARS) {
    env[name] = bundlePath ?? original[name]
  }
  return env
}
