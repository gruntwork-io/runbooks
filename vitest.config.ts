/// <reference types="vitest" />
// Backend tests use `bun test` (see justfile / package.json).
// This config exists only for web/ frontend tests via Vitest.
// Prefer running: bun run test:web  (or)  vitest run --config web/vitest.config.ts
export { default } from "./web/vitest.config.ts"
