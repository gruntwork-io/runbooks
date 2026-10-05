/**
 * A Chromium switch every e2e launch passes. The app encrypts the saved
 * session environment with Electron's safeStorage, which on macOS reads its
 * key from the login Keychain. macOS asks for permission once the Electron
 * binary changes (an upgrade), and that prompt blocks the main process until
 * someone answers it. With this switch safeStorage uses an in-memory key and
 * never opens the Keychain. Other platforms ignore it.
 */
export const MOCK_KEYCHAIN = "--use-mock-keychain"

/**
 * Env for a launch whose test expects a saved session's env or block history
 * back. Playwright starts Electron with `--password-store=basic`, which on
 * Linux leaves safeStorage only the key hardcoded in Chromium, and the app
 * saves neither with that key unless this is set. Other platforms ignore it.
 */
export const INSECURE_SESSION_KEY = { RUNBOOKS_TEST_INSECURE_SESSION_KEY: "1" }
