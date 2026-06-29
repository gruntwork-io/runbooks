import { defineConfig } from "vitest/config"

// Node-environment integration suite (test/integration/**).
//
// This project exists because Bun 1.3.x has no tls.setDefaultCACertificates:
// the TLS integration tests exercise that API against a real https server, so
// they can only run under Node. The `bun test` scripts carry
// --path-ignore-patterns='test/**' so Bun never discovers this suite; run it
// via `bun run test:integration` (the vitest binary's shebang puts it on Node).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
  },
})
