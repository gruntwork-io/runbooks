/**
 * The app's `SessionCipher`, over Electron's `safeStorage`: Keychain on
 * macOS, DPAPI on Windows, a secret service on Linux. Main passes
 * Electron's `safeStorage`; this file takes the parts it uses, so the tests
 * drive it with stand-ins.
 *
 * Encrypting and decrypting give none where the system offers no real
 * encryption, and where safeStorage throws. safeStorage throws where it
 * offers no encryption at all (its `isEncryptionAvailable()` is false), and
 * where the person refuses macOS's Keychain prompt. On Linux with no secret
 * service it encrypts with a key hardcoded in Chromium (`basic_text`), which
 * protects nothing, once told it may; the cipher gives none there too.
 *
 * Neither logs. The session store warns once that it saves no payload when
 * encrypting gives none, and reports a payload it cannot decrypt as
 * `Unreadable` in the resumed session's problems. safeStorage's errors add
 * nothing to either ("Error while decrypting the ciphertext provided to
 * safeStorage.decryptString.").
 *
 * These are safeStorage's synchronous methods, as today's app uses. Electron
 * 45 deprecates them, printing a line for each on its first call, and
 * Electron 46 removes them for `encryptStringAsync` and its kin.
 */
import { Effect, Layer, Option, Redacted } from "effect"
import { SessionCipher } from "@runbooks/core/services/SessionCipher"

/** The variable that asks an app that is not packaged to encrypt sessions with Linux's hardcoded key. */
export const INSECURE_SESSION_KEY = "RUNBOOKS_TEST_INSECURE_SESSION_KEY"

/**
 * Whether sessions may be encrypted with the key Chromium hardcodes, where
 * Linux has no secret service, so an e2e run on such a machine (Linux CI)
 * can resume a session. Only an app that is not packaged (Electron's
 * `app.isPackaged`, which an environment cannot change), started with
 * RUNBOOKS_TEST_INSECURE_SESSION_KEY=1. A packaged app never does, whatever
 * its environment says.
 */
export const insecureSessionKeyOn = (
  packaged: boolean,
  environment: Readonly<Record<string, string>>,
): boolean => !packaged && environment[INSECURE_SESSION_KEY] === "1"

/** The parts of Electron's `safeStorage` the cipher uses. */
export interface SafeStorage {
  /** Linux's only: on macOS and Windows, Electron's safeStorage has no such function. */
  getSelectedStorageBackend(): string
  /** On Linux's `basic_text` backend, lets the hardcoded key encrypt. Elsewhere it does nothing. */
  setUsePlainTextEncryption(usePlainText: boolean): void
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface SafeStorageCipherOptions {
  /** The platform main runs on: `process.platform`. */
  readonly platform: NodeJS.Platform
  /** Whether Linux's hardcoded key may encrypt: `insecureSessionKeyOn`. */
  readonly insecureKey: boolean
}

/** The session cipher over `safeStorage`. Build it once the app is ready: safeStorage encrypts nothing before. */
export const safeStorageCipher = (
  safeStorage: SafeStorage,
  { platform, insecureKey }: SafeStorageCipherOptions,
): Layer.Layer<SessionCipher> =>
  Layer.sync(SessionCipher, () => {
    // On basic_text, safeStorage encrypts nothing until it may use the hardcoded key.
    if (insecureKey) safeStorage.setUsePlainTextEncryption(true)
    /** Whether safeStorage's key may encrypt: not Linux's hardcoded one, unless the insecure key is asked for. */
    const keyAllowed = () =>
      platform !== "linux" ||
      insecureKey ||
      safeStorage.getSelectedStorageBackend() !== "basic_text"
    /** What `use` gives with a key allowed; none without one, or where safeStorage throws. */
    const withKey = <A>(use: () => A): Effect.Effect<Option.Option<A>> =>
      Effect.try(() => (keyAllowed() ? Option.some(use()) : Option.none<A>())).pipe(
        // The store reports the none, as the doc comment says, so the error goes unlogged.
        Effect.orElseSucceed(Option.none<A>),
      )
    return SessionCipher.of({
      encrypt: (plaintext) =>
        withKey(() => new Uint8Array(safeStorage.encryptString(Redacted.value(plaintext)))),
      decrypt: (ciphertext) =>
        withKey(() => Redacted.make(safeStorage.decryptString(Buffer.from(ciphertext)))),
    })
  })
