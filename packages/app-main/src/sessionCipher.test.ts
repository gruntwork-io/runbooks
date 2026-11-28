import { describe, expect, it } from "bun:test"
import { Effect, Logger, Option, Redacted, References } from "effect"
import { SessionCipher, type SessionCipherShape } from "@runbooks/core/services/SessionCipher"
import {
  insecureSessionKeyOn,
  type SafeStorage,
  type SafeStorageCipherOptions,
  safeStorageCipher,
} from "./sessionCipher.ts"

// The cipher over stand-ins for Electron's safeStorage, which behave as
// Electron 45's does on each platform.

const SECRET = "the-secret-access-key-0001"

const MARK = Buffer.from("v10")

/** Each byte XORed with a mask that varies with its position: its own inverse. */
const scramble = (bytes: Buffer) => bytes.map((byte, i) => byte ^ ((i * 7 + 13) & 0xff))

/** What `fakeSafeStorage` makes of `text`: marked and scrambled, so no plaintext shows. */
const scrambled = (text: string) => Buffer.concat([MARK, scramble(Buffer.from(text))])

interface FakeOptions {
  readonly platform: NodeJS.Platform
  /** Linux's: `gnome_libsecret` unless given. */
  readonly backend?: string
  /** Whether the system's key store gives a key. True unless given. */
  readonly keyStore?: boolean
  /** Replaces encryptString, as a refused Keychain prompt does. */
  readonly encryptString?: (plainText: string) => Buffer
  /** Replaces decryptString. */
  readonly decryptString?: (encrypted: Buffer) => string
}

/**
 * A stand-in for Electron's safeStorage on `platform`. On Linux's
 * basic_text backend it reports encryption only once plain-text encryption
 * is set, with the hardcoded key, as Electron does; off Linux,
 * getSelectedStorageBackend is not a function, as in Electron. Encrypting or
 * decrypting when it reports no encryption throws, as Electron's does.
 */
function fakeSafeStorage(options: FakeOptions): SafeStorage {
  const { platform, backend = "gnome_libsecret", keyStore = true } = options
  let plainText = false
  const isEncryptionAvailable = () =>
    platform === "linux" && backend === "basic_text" ? plainText : keyStore
  return {
    getSelectedStorageBackend: () => {
      if (platform !== "linux")
        throw new TypeError("safeStorage.getSelectedStorageBackend is not a function")
      return backend
    },
    setUsePlainTextEncryption: (use) => {
      plainText = use
    },
    encryptString:
      options.encryptString ??
      ((text) => {
        if (!isEncryptionAvailable()) throw new Error("Encryption is not available.")
        return scrambled(text)
      }),
    decryptString:
      options.decryptString ??
      ((encrypted) => {
        if (!isEncryptionAvailable()) throw new Error("Decryption is not available.")
        if (!encrypted.subarray(0, MARK.length).equals(MARK))
          throw new Error("Ciphertext does not appear to be encrypted.")
        return scramble(encrypted.subarray(MARK.length)).toString()
      }),
  }
}

/** Runs `use` with the cipher over `safeStorage`, and gives what it gave and every line logged, at every level. */
function withCipher<A>(
  safeStorage: SafeStorage,
  options: SafeStorageCipherOptions,
  use: (cipher: SessionCipherShape) => Effect.Effect<A>,
): { readonly result: A; readonly logged: ReadonlyArray<string> } {
  const logged: string[] = []
  const logger = Logger.make(({ message, cause }) => {
    logged.push(`${JSON.stringify(message)} ${String(cause)}`)
  })
  const result = Effect.runSync(
    Effect.flatMap(SessionCipher, use).pipe(
      Effect.provide(safeStorageCipher(safeStorage, options)),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    ),
  )
  return { result, logged }
}

/** What the cipher gives for encrypting SECRET, and for decrypting what `safeStorage` made of it. */
const bothWays = (cipher: SessionCipherShape) =>
  Effect.all({
    encrypted: cipher.encrypt(Redacted.make(SECRET)),
    decrypted: Effect.map(cipher.decrypt(scrambled(SECRET)), Option.map(Redacted.value)),
  })

const NOTHING = { encrypted: Option.none(), decrypted: Option.none() }

describe("the app's session cipher", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "encrypts with safeStorage on %s, and decrypts what safeStorage encrypted",
    (platform) => {
      const safeStorage = fakeSafeStorage({ platform })
      const { result } = withCipher(safeStorage, { platform, insecureKey: false }, (cipher) =>
        Effect.gen(function* () {
          const encrypted = yield* cipher.encrypt(Redacted.make(SECRET))
          const decrypted = yield* cipher.decrypt(Option.getOrThrow(encrypted))
          return { encrypted, decrypted }
        }),
      )
      expect(Option.map(result.encrypted, Buffer.from)).toEqual(Option.some(scrambled(SECRET)))
      expect(Buffer.from(Option.getOrThrow(result.encrypted)).includes(SECRET)).toBe(false)
      const decrypted = Option.getOrThrow(result.decrypted)
      expect(Redacted.isRedacted(decrypted)).toBe(true)
      expect(Redacted.value(decrypted)).toBe(SECRET)
    },
  )

  it.each(["darwin", "win32", "linux"] as const)(
    "encrypts and decrypts nothing on %s when the system offers no encryption",
    (platform) => {
      const safeStorage = fakeSafeStorage({ platform, keyStore: false })
      expect(withCipher(safeStorage, { platform, insecureKey: false }, bothWays).result).toEqual(
        NOTHING,
      )
    },
  )

  it("encrypts and decrypts nothing on Linux's basic_text backend, whose key is hardcoded in Chromium", () => {
    const options = { platform: "linux", insecureKey: false } as const
    const basicText = fakeSafeStorage({ platform: "linux", backend: "basic_text" })
    expect(withCipher(basicText, options, bothWays).result).toEqual(NOTHING)
    // Nor once something else in main has let safeStorage use the hardcoded key.
    const allowed = fakeSafeStorage({ platform: "linux", backend: "basic_text" })
    allowed.setUsePlainTextEncryption(true)
    expect(withCipher(allowed, options, bothWays).result).toEqual(NOTHING)
  })

  it("encrypts with the hardcoded key when asked, on Linux's basic_text backend only", () => {
    const asked = { insecureKey: true } as const
    const basicText = fakeSafeStorage({ platform: "linux", backend: "basic_text" })
    expect(withCipher(basicText, { platform: "linux", ...asked }, bothWays).result).toEqual({
      encrypted: Option.some(new Uint8Array(scrambled(SECRET))),
      decrypted: Option.some(SECRET),
    })
    // It stands in for no key store that gives no key: a locked secret service, or macOS's or Windows'.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const noKey = fakeSafeStorage({ platform, keyStore: false })
      expect(withCipher(noKey, { platform, ...asked }, bothWays).result).toEqual(NOTHING)
    }
  })

  it("asks for the hardcoded key only unpackaged, when RUNBOOKS_TEST_INSECURE_SESSION_KEY=1 asks", () => {
    const on = { RUNBOOKS_TEST_INSECURE_SESSION_KEY: "1" }
    expect(insecureSessionKeyOn(false, on)).toBe(true)
    expect(insecureSessionKeyOn(true, on)).toBe(false)
    expect(insecureSessionKeyOn(false, {})).toBe(false)
    expect(insecureSessionKeyOn(false, { RUNBOOKS_TEST_INSECURE_SESSION_KEY: "true" })).toBe(false)
  })

  it("gives none when safeStorage throws encrypting, as when the person refuses the Keychain prompt", () => {
    const refused = fakeSafeStorage({
      platform: "darwin",
      encryptString: () => {
        throw new Error("User denied Keychain access")
      },
    })
    const { result } = withCipher(refused, { platform: "darwin", insecureKey: false }, bothWays)
    expect(result).toEqual({ encrypted: Option.none(), decrypted: Option.some(SECRET) })
  })

  it("gives none when safeStorage throws decrypting: another key's ciphertext, or one it never encrypted", () => {
    const otherKey = fakeSafeStorage({
      platform: "darwin",
      decryptString: () => {
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
        )
      },
    })
    const options = { platform: "darwin", insecureKey: false } as const
    expect(withCipher(otherKey, options, bothWays).result).toEqual({
      encrypted: Option.some(new Uint8Array(scrambled(SECRET))),
      decrypted: Option.none(),
    })
    const { result } = withCipher(fakeSafeStorage({ platform: "darwin" }), options, (cipher) =>
      cipher.decrypt(Buffer.from(SECRET)),
    )
    expect(result).toEqual(Option.none())
  })

  it("logs no plaintext, on any path, even from an error that holds it", () => {
    const leaky = (text: string): never => {
      throw new Error(`safeStorage refused ${text}`)
    }
    const paths: ReadonlyArray<readonly [FakeOptions, SafeStorageCipherOptions]> = [
      [{ platform: "darwin" }, { platform: "darwin", insecureKey: false }],
      [
        { platform: "darwin", keyStore: false },
        { platform: "darwin", insecureKey: false },
      ],
      [
        { platform: "linux", backend: "basic_text" },
        { platform: "linux", insecureKey: false },
      ],
      [
        { platform: "linux", backend: "basic_text" },
        { platform: "linux", insecureKey: true },
      ],
      [
        { platform: "darwin", encryptString: leaky, decryptString: () => leaky(SECRET) },
        { platform: "darwin", insecureKey: false },
      ],
    ]
    for (const [fake, options] of paths) {
      const { logged } = withCipher(fakeSafeStorage(fake), options, bothWays)
      expect(logged.filter((line) => line.includes(SECRET))).toEqual([])
    }
  })
})
