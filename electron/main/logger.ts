/**
 * Re-exports the shared logger from src/ so existing imports keep working.
 *
 * See src/logger.ts for usage and DEBUG patterns.
 */
export { makeLogger, type Logger } from "../../src/logger.ts"
